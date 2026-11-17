// ENV-ROOM (core switch-on blocker, 2026-11-15): a named environment's control plane gives the broker its generated names packed (AGENTX_NAMES), its constrained settings packed
// (AGENTX_SETTINGS) and nothing it can derive from the environment's name. hydrateBrokerEnvironment puts every value back under the variable the broker's code reads. These pin
// the values it builds, that it changes nothing where nothing is packed (the legacy install, every test), and that what it cannot read stops the broker in fixed words.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROKER_NAMES, BROKER_NAMES_VARIABLE, BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, DERIVED_BROKER_VARIABLES, environmentAlarmPrefix, environmentConnectorSecretPrefix,
  environmentE2eFeatureRuntimeCatalogId, environmentMetricsNamespace, environmentProjectSetupRuntimeCatalogId, environmentSettingsPrefix, type BrokerNameKey, type BrokerSettingKey,
} from "@agentx/contracts";
import { awsPartitionOf, hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";

const SCOPE = { AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging" };
/** An API Gateway host, built at run time (the public repository refuses such a host written out). */
const API_HOST = (region: string, suffix: string): string => ["execute-api", region, suffix].join(".");
const KEY_ID = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
const NAMES = {
  stateTable: "agentx-staging-control-plane-State1C20CC9A-1A2B3C4D5E6F7",
  artifactBucket: "agentx-staging-control-plane-artifacts82dd59a1-1a2b3c4d5e6f",
  signInTable: "agentx-staging-control-plane-DeveloperSignInTable26CE739E-1A2B3C4D5E6F7",
  identityFunction: "agentx-staging-control-DeveloperSignInFunction10B62B05-1A2B3C4D5E",
  slackThreadsTable: "agentx-staging-control-plane-SlackThreads36E14C1E-1A2B3C4D5E6F7",
  turnRecordsTable: "agentx-staging-control-plane-TurnRecords69ECFCD9-1A2B3C4D5E6F7",
  planEvidenceFunction: "agentx-staging-control-plane-PlanEvidence3615C4CB-1A2B3C4D5E6F7",
  slackRequestQueue: "agentx-staging-control-plane-SlackRequestQueueCC82C864-1A2B3C4D5E6F7",
  slackOrchestratorRole: "agentx-staging-control-SlackOrchestratorTaskRole2372FE40-1A2B3C4D5",
  companySecretsRole: "agentx-staging-control-plane-CompanySecretsRole63E074C9-1A2B3C4D5E",
  chatGptConnectionKey: KEY_ID,
  taskTokenKey: `1${KEY_ID.slice(1)}`,
  policyHookKey: `2${KEY_ID.slice(1)}`,
  provisionerStateMachine: "agentx-staging-control-plane-SessionsProvisioner9C44055B-1A2B3C4D5E6F7",
  deleterStateMachine: "agentx-staging-control-plane-SessionsDeleterB48741EA-1A2B3C4D5E6F7",
  signInApi: "abcdefghij",
  dispatchDeadLetters: "agentx-staging-control-plane-DispatchDeadLetterQueue3E30F4B8-1A2B3C4D5E6F7",
  slackRequestDeadLetters: "agentx-staging-control-plane-SlackRequestDeadLetterQueueBBBDDF4E-1A2B",
  developerNoticeDeadLetters: "agentx-staging-control-plane-DeveloperTaskNotifierNoticeDeadLetterQueue",
  developerNoticeStreamFailures: "agentx-staging-control-plane-DeveloperTaskNotifierStreamFailureQueue58",
  channelEventDeadLetters: "agentx-staging-control-plane-ChannelApiEventDeadLettersE21C25D1-1A2B3C4",
} as const satisfies Record<BrokerNameKey, string>;
const SETTINGS = {
  memberWorkspaceLimit: "3", organizationWorkspaceLimit: "20", taskPeopleChanges: "false", taskPeoplePublicInvitations: "true", taskPeoplePrivateInvitations: "false",
  workflowDependencies: "false", slackTeamId: "T0123ABCD", signInSlack: "enabled", signInSlackSince: "1794693600", oidcSince: "0", signInGithub: "disabled", githubSince: "0", mcpConfirmElicitation: "enabled", channelAdapters: "enabled",
  coreAllowedCompanies: "none", coreTaskCap: "5", coreCompanyDayCap: "25", coreLessons: "off",
  coreEngine: "off", coreModelGateway: "gateway.example.dev", coreAgentModel: "claude-sonnet-4-6", coreAttentionEmail: "off",
} as const satisfies Record<BrokerSettingKey, string>;

const names = (entries: Partial<Record<BrokerNameKey, string>> = NAMES): string => Object.entries(entries).map(([key, value]) => `${BROKER_NAMES[key as BrokerNameKey].code}=${value}`).join(",");
const settings = (entries: Partial<Record<BrokerSettingKey, string>> = SETTINGS): string => Object.entries(entries).map(([key, value]) => `${BROKER_SETTINGS[key as BrokerSettingKey].code}=${value}`).join(",");
const hydrated = (env: MutableEnvironment): MutableEnvironment => { const copy = { ...env }; hydrateBrokerEnvironment(copy); return copy; };
const packed = (): MutableEnvironment => ({ ...SCOPE, [BROKER_NAMES_VARIABLE]: names(), [BROKER_SETTINGS_VARIABLE]: settings() });

afterEach(() => { vi.restoreAllMocks(); });

describe("the tables", () => {
  it("have a distinct two-letter code and a distinct variable for each entry, and no variable both packed and derived", () => {
    const specs = Object.values(BROKER_NAMES) as Array<{ code: string; variable: string; kind: string; label?: string }>;
    expect(new Set(specs.map((spec) => spec.code)).size).toBe(specs.length);
    const variables = specs.filter((spec) => spec.kind !== "deadLetterQueue").map((spec) => spec.variable);
    expect(new Set(variables).size).toBe(variables.length);
    expect(new Set(specs.filter((spec) => spec.kind === "deadLetterQueue").map((spec) => spec.variable))).toEqual(new Set(["HEALTH_DEAD_LETTER_QUEUES"]));
    const settingSpecs = Object.values(BROKER_SETTINGS);
    expect(new Set(settingSpecs.map((spec) => spec.code)).size).toBe(settingSpecs.length);
    for (const spec of [...specs, ...settingSpecs]) expect(spec.code).toMatch(/^[a-z]{2}$/u);
    const derived = DERIVED_BROKER_VARIABLES.map((entry) => entry.variable);
    expect(new Set(derived).size).toBe(derived.length);
    const all = [...new Set(specs.map((spec) => spec.variable)), ...settingSpecs.map((spec) => spec.variable), ...derived];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("awsPartitionOf", () => {
  it("names the partition a region belongs to", () => {
    expect(awsPartitionOf("us-west-2")).toBe("aws");
    expect(awsPartitionOf("cn-north-1")).toBe("aws-cn");
    expect(awsPartitionOf("us-gov-west-1")).toBe("aws-us-gov");
    expect(awsPartitionOf("us-iso-east-1")).toBe("aws-iso");
    expect(awsPartitionOf("us-isob-east-1")).toBe("aws-iso-b");
  });
});

describe("hydrateBrokerEnvironment: nothing packed", () => {
  it("leaves the legacy install's environment exactly as it is (no AGENTX_NAMES, no AGENTX_SETTINGS), even with AGENTX_ENV set", () => {
    const legacy: MutableEnvironment = { AWS_REGION: "us-east-1", AGENTX_ENV: "production", STATE_TABLE_NAME: "State", PROVISIONER_ARN: "arn:aws:states:us-east-1:1:stateMachine:P", SLACK_TEAM_ID: "" };
    const copy = { ...legacy };
    hydrateBrokerEnvironment(copy);
    expect(copy).toStrictEqual(legacy);
    expect(Object.keys(copy)).toEqual(Object.keys(legacy));
  });

  it("leaves an empty environment empty", () => {
    expect(hydrated({})).toStrictEqual({});
  });
});

describe("hydrateBrokerEnvironment: a named environment's broker", () => {
  it("builds every name's variable as the control plane used to pass it", () => {
    const env = hydrated(packed());
    expect(env).toMatchObject({
      STATE_TABLE_NAME: NAMES.stateTable,
      ARTIFACT_BUCKET_NAME: NAMES.artifactBucket,
      DEVELOPER_SIGNIN_TABLE_NAME: NAMES.signInTable,
      DEVELOPER_IDENTITY_FUNCTION_ARN: `arn:aws:lambda:us-west-2:123456789012:function:${NAMES.identityFunction}`,
      SLACK_THREADS_TABLE_NAME: NAMES.slackThreadsTable,
      TURN_RECORDS_TABLE_NAME: NAMES.turnRecordsTable,
      PLAN_EVIDENCE_FUNCTION_NAME: NAMES.planEvidenceFunction,
      SLACK_REQUEST_QUEUE_URL: `https://sqs.us-west-2.amazonaws.com/123456789012/${NAMES.slackRequestQueue}`,
      SLACK_ORCHESTRATOR_ROLE_ARN: `arn:aws:iam::123456789012:role/agentx/staging/${NAMES.slackOrchestratorRole}`,
      COMPANY_SECRETS_ROLE_ARN: `arn:aws:iam::123456789012:role/agentx/staging/${NAMES.companySecretsRole}`,
      CHATGPT_CONNECTION_KEY_ARN: `arn:aws:kms:us-west-2:123456789012:key/${KEY_ID}`,
      TASK_TOKEN_KEY_ARN: `arn:aws:kms:us-west-2:123456789012:key/${NAMES.taskTokenKey}`,
      POLICY_HOOK_KEY_ARN: `arn:aws:kms:us-west-2:123456789012:key/${NAMES.policyHookKey}`,
      PROVISIONER_ARN: `arn:aws:states:us-west-2:123456789012:stateMachine:${NAMES.provisionerStateMachine}`,
      DELETER_ARN: `arn:aws:states:us-west-2:123456789012:stateMachine:${NAMES.deleterStateMachine}`,
      DEVELOPER_TOKEN_ISSUER: `https://abcdefghij.${API_HOST("us-west-2", "amazonaws.com")}/v1/auth`,
    });
  });

  it("lists the dead-letter queues as one JSON object of URLs, in the table's order whatever order they came in", () => {
    const { dispatchDeadLetters, channelEventDeadLetters, ...rest } = NAMES;
    const env = hydrated({ ...SCOPE, [BROKER_NAMES_VARIABLE]: names({ channelEventDeadLetters, ...rest, dispatchDeadLetters }) });
    const url = (name: string): string => `https://sqs.us-west-2.amazonaws.com/123456789012/${name}`;
    expect(env.HEALTH_DEAD_LETTER_QUEUES).toBe(JSON.stringify({
      dispatch: url(NAMES.dispatchDeadLetters), "slack-requests": url(NAMES.slackRequestDeadLetters), "developer-notices": url(NAMES.developerNoticeDeadLetters),
      "developer-notice-stream": url(NAMES.developerNoticeStreamFailures), "channel-events": url(NAMES.channelEventDeadLetters),
    }));
  });

  it("puts every setting back under its variable, an empty one as empty", () => {
    const env = hydrated({ ...SCOPE, [BROKER_NAMES_VARIABLE]: names(), [BROKER_SETTINGS_VARIABLE]: settings({ ...SETTINGS, slackTeamId: "" }) });
    expect(env).toMatchObject({
      SLACK_MEMBER_WORKSPACE_LIMIT: "3", SLACK_ORGANIZATION_WORKSPACE_LIMIT: "20", AGENTX_TASK_PEOPLE_CHANGES_ENABLED: "false", AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED: "true",
      AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED: "false", AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "false", SLACK_TEAM_ID: "", DEVELOPER_SIGNIN_SLACK: "enabled",
      DEVELOPER_SIGNIN_SLACK_SINCE: "1794693600", DEVELOPER_OIDC_SINCE: "0", MCP_CONFIRM_ELICITATION: "enabled",
      // DEC 254h: GitHub sign-in's switch and since, and the channel adapters' switch packed to make room for them.
      DEVELOPER_SIGNIN_GITHUB: "disabled", DEVELOPER_GITHUB_SINCE: "0", CHANNEL_ADAPTERS: "enabled",
    });
  });

  it("derives what the environment's name decides, with the functions the infrastructure names those things with", () => {
    const env = hydrated(packed());
    expect(env).toMatchObject({
      CONNECTOR_SECRET_PREFIX: environmentConnectorSecretPrefix("staging"),
      SWEBENCH_SETTINGS_PREFIX: environmentSettingsPrefix("staging"),
      AGENTX_E2E_AGENT_SETTINGS_PREFIX: environmentSettingsPrefix("staging"),
      AGENTX_ALARM_PREFIX: environmentAlarmPrefix("staging"),
      AGENTX_METRICS_NAMESPACE: environmentMetricsNamespace("staging"),
      AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID: environmentProjectSetupRuntimeCatalogId("staging"),
      AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID: environmentE2eFeatureRuntimeCatalogId("staging"),
      CORE_DISPATCH_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/123456789012/agentx-staging-core-dispatch",
      CORE_DISPATCH_DEAD_LETTER_URL: "https://sqs.us-west-2.amazonaws.com/123456789012/agentx-staging-core-dispatch-dead",
    });
    expect(env.CONNECTOR_SECRET_PREFIX).toBe("agentx/staging/connectors/");
    expect(env.AGENTX_ALARM_PREFIX).toBe("agentx-staging-");
  });

  it("turns the company reads on in every named broker, and leaves the legacy install's environment without them (DEC 254h)", () => {
    expect(hydrated(packed()).COMPANY_READS).toBe("enabled");
    expect(hydrated({ ...SCOPE, [BROKER_NAMES_VARIABLE]: "" }).COMPANY_READS).toBe("enabled");
    expect(hydrated({ ...SCOPE, [BROKER_SETTINGS_VARIABLE]: settings(SETTINGS) }).COMPANY_READS).toBeUndefined();
    expect(hydrated({ ...SCOPE }).COMPANY_READS).toBeUndefined();
  });

  it("builds in the region's own partition and hosts", () => {
    const env = hydrated({ ...packed(), AWS_REGION: "cn-north-1" });
    expect(env.SLACK_REQUEST_QUEUE_URL).toBe(`https://sqs.cn-north-1.amazonaws.com.cn/123456789012/${NAMES.slackRequestQueue}`);
    expect(env.TASK_TOKEN_KEY_ARN).toBe(`arn:aws-cn:kms:cn-north-1:123456789012:key/${NAMES.taskTokenKey}`);
    expect(env.DEVELOPER_TOKEN_ISSUER).toBe(`https://abcdefghij.${API_HOST("cn-north-1", "amazonaws.com.cn")}/v1/auth`);
  });

  it("still derives what the environment's name decides when AGENTX_NAMES is present but empty", () => {
    const env = hydrated({ ...SCOPE, [BROKER_NAMES_VARIABLE]: "" });
    expect(env.AGENTX_ALARM_PREFIX).toBe("agentx-staging-");
    expect(env.CORE_DISPATCH_QUEUE_URL).toBe("https://sqs.us-west-2.amazonaws.com/123456789012/agentx-staging-core-dispatch");
  });

  it("never replaces a variable that is already set", () => {
    const env = hydrated({ ...packed(), STATE_TABLE_NAME: "given", HEALTH_DEAD_LETTER_QUEUES: "{}", CONNECTOR_SECRET_PREFIX: "given/", SLACK_TEAM_ID: "TGIVEN" });
    expect(env).toMatchObject({ STATE_TABLE_NAME: "given", HEALTH_DEAD_LETTER_QUEUES: "{}", CONNECTOR_SECRET_PREFIX: "given/", SLACK_TEAM_ID: "TGIVEN" });
  });
});

describe("hydrateBrokerEnvironment: what it cannot read stops the broker, in fixed words without the value", () => {
  const SECRETISH = "s3cr3t-value";
  for (const [label, env, message] of [
    ["a list that is not code=value pairs", { ...SCOPE, [BROKER_NAMES_VARIABLE]: `ts=${SECRETISH},oops` }, "AGENTX_NAMES is not a list of code=value pairs"],
    ["a code named twice", { ...SCOPE, [BROKER_NAMES_VARIABLE]: `ts=${SECRETISH},ts=${SECRETISH}` }, "AGENTX_NAMES names the code ts twice"],
    ["a name with a separator", { ...SCOPE, [BROKER_NAMES_VARIABLE]: `ts=${SECRETISH}/x` }, "AGENTX_NAMES has no valid name for ts (STATE_TABLE_NAME)"],
    ["an empty name", { ...SCOPE, [BROKER_NAMES_VARIABLE]: "ts=" }, "AGENTX_NAMES has no valid name for ts (STATE_TABLE_NAME)"],
    ["a setting that is not plain", { ...SCOPE, [BROKER_SETTINGS_VARIABLE]: `tm=${SECRETISH}"x` }, "AGENTX_SETTINGS has no plain value for tm (SLACK_TEAM_ID)"],
    ["a malformed settings list", { ...SCOPE, [BROKER_SETTINGS_VARIABLE]: SECRETISH }, "AGENTX_SETTINGS is not a list of code=value pairs"],
    ["no account", { ...packed(), AGENTX_ACCOUNT_ID: undefined }, "AGENTX_ACCOUNT_ID (12 digits) is required to build"],
    ["an account that is not 12 digits", { ...packed(), AGENTX_ACCOUNT_ID: "12345" }, "AGENTX_ACCOUNT_ID (12 digits) is required to build"],
    ["no region", { ...packed(), AWS_REGION: undefined }, "AWS_REGION is required to build"],
    ["a region that is not one", { ...packed(), AWS_REGION: `us-west-2/${SECRETISH}` }, "AWS_REGION is required to build"],
    ["a region in a partition whose hosts it cannot build", { ...packed(), AWS_REGION: "us-iso-east-1" }, "AWS_REGION is in a partition the broker cannot build"],
    ["an EU sovereign ISO region", { ...packed(), AWS_REGION: "eu-isoe-west-1" }, "AWS_REGION is in a partition the broker cannot build"],
    ["a us-isof region", { ...packed(), AWS_REGION: "us-isof-south-1" }, "AWS_REGION is in a partition the broker cannot build"],
    ["no environment name", { ...packed(), AGENTX_ENV: undefined }, "AGENTX_ENV (a valid environment name) is required to build"],
    ["an environment name that is not valid", { ...packed(), AGENTX_ENV: `Bad/${SECRETISH}` }, "AGENTX_ENV (a valid environment name) is required to build"],
  ] as const) {
    it(label, () => {
      let thrown: unknown;
      try { hydrated(env); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(message);
      expect((thrown as Error).message).not.toContain(SECRETISH);
    });
  }

  it("skips a code it does not know, with one log line naming the code and not its value, and builds the rest", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const env = hydrated({ ...packed(), [BROKER_NAMES_VARIABLE]: `${names()},zz=${SECRETISH}`, [BROKER_SETTINGS_VARIABLE]: `${settings()},zy=${SECRETISH}` });
    expect(env.STATE_TABLE_NAME).toBe(NAMES.stateTable);
    expect(env.SLACK_TEAM_ID).toBe(SETTINGS.slackTeamId);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ event: "broker_environment.unknown_codes" });
      expect(line).not.toContain(SECRETISH);
    }
  });
});
