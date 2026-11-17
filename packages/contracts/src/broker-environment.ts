/**
 * The broker's environment, compacted (ENV-ROOM; core switch-on blocker, 2026-11-15).
 *
 * Lambda holds all of a function's environment variables, keys and values together, to 4 KB (counted as the JSON of the map), and the broker of a named environment was over it
 * once the core switch-on lanes added their settings: every resource CloudFormation names for it is `<stack>-<LogicalId>-<random>`, 60 to 90 characters, and a variable's key is
 * often as long again. So, in a named environment only (the legacy install passes its variables whole, and its template is unchanged):
 *  - the names CloudFormation generates come in one variable, AGENTX_NAMES, as `code=value` pairs under two-letter codes (BROKER_NAMES). A queue, a key, a state machine, a
 *    function or a role arrives as its bare name or id, and its `kind` says what the broker turns it into (the URL or the ARN the variable always held);
 *  - the settings that are constrained stack parameters (flags, limits, epoch seconds, the Slack team) come in one variable, AGENTX_SETTINGS (BROKER_SETTINGS), the same way;
 *  - what the environment's name decides (the secret, settings and alarm prefixes, the metrics namespace, the runtime catalog ids, the core dispatch queues) is not passed at
 *    all: DERIVED_BROKER_VARIABLES builds it from AGENTX_ENV with the functions the infrastructure names those things with.
 * The broker puts every value back under the variable its code has always read, before anything reads it (packages/broker/src/aws/broker-environment.ts), so no reader changes.
 * URLs and ARNs are built from the region Lambda gives every function (AWS_REGION) and the account (AGENTX_ACCOUNT_ID, the one variable this adds).
 *
 * The infrastructure (infra/lib/broker-names.ts) and the broker both take these tables, so a name added to one cannot be missing from the other.
 * tests/contract/lambda-environment-size.test.ts holds the broker under its ceiling with the longest names: a value that can be derived is derived, not added as a variable.
 */
import { coreDispatchDeadLetterName, coreDispatchQueueName, CORE_AGENT_MODEL_VARIABLE, CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE, CORE_DISPATCH_QUEUE_URL_VARIABLE, CORE_ENGINE_VARIABLE, CORE_MODEL_GATEWAY_URL_VARIABLE } from "./core-engine-infra.js";
import {
  environmentAlarmPrefix,
  environmentChannelAdapterSecretPrefix,
  environmentConnectorSecretPrefix,
  environmentE2eFeatureRuntimeCatalogId,
  environmentMetricsNamespace,
  environmentProjectSetupRuntimeCatalogId,
  environmentSettingsPrefix,
} from "./environments.js";

/** The names the broker is given, as one variable. */
export const BROKER_NAMES_VARIABLE = "AGENTX_NAMES";
/** The constrained settings the broker is given, as one variable. */
export const BROKER_SETTINGS_VARIABLE = "AGENTX_SETTINGS";
/** The account the broker builds ARNs and queue URLs in (12 digits). The region is Lambda's own AWS_REGION. */
export const BROKER_ACCOUNT_VARIABLE = "AGENTX_ACCOUNT_ID";

/**
 * How AGENTX_NAMES and AGENTX_SETTINGS are written: `code=value` pairs joined by commas (`ts=agentx-staging-table,ar=agentx-staging-bucket`). Lambda counts the JSON of the map, so a
 * quote inside a value costs two bytes; this form has none. The values hold no quote, comma, equals sign, brace, slash or space (the infrastructure refuses a parameter or a literal
 * that could), so nothing is escaped. Anything else is an error, never a partial read.
 */
export type BrokerListEntries = { entries: Array<[string, string]> } | { error: string };

export function decodeBrokerList(raw: string): BrokerListEntries {
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const pair of raw.split(",")) {
    const match = /^([a-z]{2})=([^=]*)$/u.exec(pair);
    if (match === null) return { error: "is not a list of code=value pairs" };
    if (seen.has(match[1]!)) return { error: `names the code ${match[1]!} twice` };
    seen.add(match[1]!);
    entries.push([match[1]!, match[2]!]);
  }
  return { entries };
}

export type BrokerNameKind =
  /** Used as it is. */
  | "name"
  /** A queue's name; the variable gets its URL. */
  | "queueUrl"
  /** A KMS key's id; the variable gets its ARN. */
  | "kmsKeyArn"
  /** A state machine's name; the variable gets its ARN. */
  | "stateMachineArn"
  /** A Lambda function's name; the variable gets its ARN (`arn:<partition>:lambda:<region>:<account>:function:<name>`). */
  | "lambdaFunctionArn"
  /** A role's name, in the environment's role path (`/agentx/<env>/`, every role of a named environment's control plane); the variable gets its ARN. */
  | "roleArn"
  /** An HTTP API's id; the variable gets the control plane's sign-in issuer (`https://<id>.execute-api.<region>.amazonaws.com/v1/auth`). */
  | "apiIssuer"
  /** A dead-letter queue's name, which the health route lists under `label`; the variable gets the JSON of every such queue, `{ label: URL }`, in this table's order. */
  | "deadLetterQueue";

export interface BrokerNameSpec {
  /** The key in AGENTX_NAMES: two letters. */
  readonly code: string;
  /** The variable the broker's code reads the value as. */
  readonly variable: string;
  readonly kind: BrokerNameKind;
  /** For a dead-letter queue: how the health route names it. */
  readonly label?: string;
}

/**
 * Two-letter codes, each used once and never given a second meaning: a retired code is not reused.
 */
export const BROKER_NAMES = {
  stateTable: { code: "ts", variable: "STATE_TABLE_NAME", kind: "name" },
  artifactBucket: { code: "ar", variable: "ARTIFACT_BUCKET_NAME", kind: "name" },
  signInTable: { code: "st", variable: "DEVELOPER_SIGNIN_TABLE_NAME", kind: "name" },
  identityFunction: { code: "id", variable: "DEVELOPER_IDENTITY_FUNCTION_ARN", kind: "lambdaFunctionArn" },
  slackThreadsTable: { code: "sl", variable: "SLACK_THREADS_TABLE_NAME", kind: "name" },
  turnRecordsTable: { code: "tr", variable: "TURN_RECORDS_TABLE_NAME", kind: "name" },
  planEvidenceFunction: { code: "pe", variable: "PLAN_EVIDENCE_FUNCTION_NAME", kind: "name" },
  slackRequestQueue: { code: "sq", variable: "SLACK_REQUEST_QUEUE_URL", kind: "queueUrl" },
  slackOrchestratorRole: { code: "so", variable: "SLACK_ORCHESTRATOR_ROLE_ARN", kind: "roleArn" },
  companySecretsRole: { code: "cs", variable: "COMPANY_SECRETS_ROLE_ARN", kind: "roleArn" },
  chatGptConnectionKey: { code: "ck", variable: "CHATGPT_CONNECTION_KEY_ARN", kind: "kmsKeyArn" },
  taskTokenKey: { code: "kt", variable: "TASK_TOKEN_KEY_ARN", kind: "kmsKeyArn" },
  policyHookKey: { code: "kp", variable: "POLICY_HOOK_KEY_ARN", kind: "kmsKeyArn" },
  provisionerStateMachine: { code: "pv", variable: "PROVISIONER_ARN", kind: "stateMachineArn" },
  deleterStateMachine: { code: "dl", variable: "DELETER_ARN", kind: "stateMachineArn" },
  signInApi: { code: "ti", variable: "DEVELOPER_TOKEN_ISSUER", kind: "apiIssuer" },
  dispatchDeadLetters: { code: "dq", variable: "HEALTH_DEAD_LETTER_QUEUES", kind: "deadLetterQueue", label: "dispatch" },
  slackRequestDeadLetters: { code: "sr", variable: "HEALTH_DEAD_LETTER_QUEUES", kind: "deadLetterQueue", label: "slack-requests" },
  developerNoticeDeadLetters: { code: "dn", variable: "HEALTH_DEAD_LETTER_QUEUES", kind: "deadLetterQueue", label: "developer-notices" },
  developerNoticeStreamFailures: { code: "ds", variable: "HEALTH_DEAD_LETTER_QUEUES", kind: "deadLetterQueue", label: "developer-notice-stream" },
  channelEventDeadLetters: { code: "ce", variable: "HEALTH_DEAD_LETTER_QUEUES", kind: "deadLetterQueue", label: "channel-events" },
} as const satisfies Record<string, BrokerNameSpec>;

export type BrokerNameKey = keyof typeof BROKER_NAMES;

/** What a setting's value may be: letters, digits and `. _ : -`, at most 64 characters, or empty. */
export const BROKER_SETTING_VALUE = /^[A-Za-z0-9._:-]{0,64}$/u;

export interface BrokerSettingSpec {
  /** The key in AGENTX_SETTINGS: two letters. */
  readonly code: string;
  /** The variable the broker's code reads the value as. */
  readonly variable: string;
  /** The value is a host (with an optional port) and the variable gets its https origin, `https://<value>`; an empty value stays empty. A slash cannot be packed, so the scheme is added here. */
  readonly httpsOrigin?: true;
}

/**
 * The broker's settings that are stack parameters already constrained to plain text (a Number, an AllowedValues list or an AllowedPattern without separators): the infrastructure
 * refuses any other. A free-text value (an issuer URL, JSON) does not belong here; it stays a variable of its own, or it is derived. Codes as in BROKER_NAMES: once each, never reused.
 */
export const BROKER_SETTINGS = {
  memberWorkspaceLimit: { code: "ml", variable: "SLACK_MEMBER_WORKSPACE_LIMIT" },
  organizationWorkspaceLimit: { code: "ol", variable: "SLACK_ORGANIZATION_WORKSPACE_LIMIT" },
  taskPeopleChanges: { code: "tc", variable: "AGENTX_TASK_PEOPLE_CHANGES_ENABLED" },
  taskPeoplePublicInvitations: { code: "tu", variable: "AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED" },
  taskPeoplePrivateInvitations: { code: "tv", variable: "AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED" },
  workflowDependencies: { code: "wd", variable: "AGENTX_WORKFLOW_DEPENDENCIES_ENABLED" },
  slackTeamId: { code: "tm", variable: "SLACK_TEAM_ID" },
  signInSlack: { code: "ss", variable: "DEVELOPER_SIGNIN_SLACK" },
  signInSlackSince: { code: "sn", variable: "DEVELOPER_SIGNIN_SLACK_SINCE" },
  oidcSince: { code: "os", variable: "DEVELOPER_OIDC_SINCE" },
  mcpConfirmElicitation: { code: "mc", variable: "MCP_CONFIRM_ELICITATION" },
  coreAllowedCompanies: { code: "ac", variable: "ROVARA_CORE_ALLOWED_COMPANIES" },
  coreTaskCap: { code: "ct", variable: "ROVARA_CORE_TASK_CAP_USD" },
  coreCompanyDayCap: { code: "cd", variable: "ROVARA_CORE_COMPANY_DAY_CAP_USD" },
  coreLessons: { code: "cl", variable: "ROVARA_CORE_LESSONS" },
  // Core switch-on blocker (2026-11-17): the switch, and the model gateway's host and agent model (the stack parameters CoreEngine, CoreModelGatewayHost and CoreAgentModel), packed
  // to make room for the gateway settings in the broker's 4 KB.
  coreEngine: { code: "sw", variable: CORE_ENGINE_VARIABLE },
  coreModelGateway: { code: "gw", variable: CORE_MODEL_GATEWAY_URL_VARIABLE, httpsOrigin: true },
  coreAgentModel: { code: "am", variable: CORE_AGENT_MODEL_VARIABLE },
} as const satisfies Record<string, BrokerSettingSpec>;

export type BrokerSettingKey = keyof typeof BROKER_SETTINGS;

/**
 * A variable the broker builds from the environment's name:
 *  - `text`: a string the name decides;
 *  - `queueUrl`: the URL of a queue with a fixed name (built with the region and the account).
 */
export type DerivedBrokerVariable =
  | { readonly variable: string; readonly kind: "text"; readonly value: (env: string) => string }
  | { readonly variable: string; readonly kind: "queueUrl"; readonly queueName: (env: string) => string };

/** Every variable the broker derives. The infrastructure checks, at synthesis, that each `text` value is the one it would have passed (infra/lib/broker-names.ts). */
export const DERIVED_BROKER_VARIABLES: readonly DerivedBrokerVariable[] = [
  { variable: "CONNECTOR_SECRET_PREFIX", kind: "text", value: environmentConnectorSecretPrefix },
  { variable: "SWEBENCH_SETTINGS_PREFIX", kind: "text", value: environmentSettingsPrefix },
  { variable: "AGENTX_E2E_AGENT_SETTINGS_PREFIX", kind: "text", value: environmentSettingsPrefix },
  { variable: "AGENTX_ALARM_PREFIX", kind: "text", value: environmentAlarmPrefix },
  { variable: "AGENTX_METRICS_NAMESPACE", kind: "text", value: environmentMetricsNamespace },
  { variable: "AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID", kind: "text", value: environmentProjectSetupRuntimeCatalogId },
  { variable: "AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID", kind: "text", value: environmentE2eFeatureRuntimeCatalogId },
  // Core switch-on blocker (2026-11-17): the channel adapters' secret prefix is the environment's own, so it is derived, making room for the gateway settings.
  { variable: "CHANNEL_ADAPTER_SECRET_PREFIX", kind: "text", value: environmentChannelAdapterSecretPrefix },
  // Core switch-on lane L1a: the core dispatch queue and its dead letters have fixed names (core-engine-infra.ts), so the broker builds their URLs; nothing is passed.
  { variable: CORE_DISPATCH_QUEUE_URL_VARIABLE, kind: "queueUrl", queueName: coreDispatchQueueName },
  { variable: CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE, kind: "queueUrl", queueName: coreDispatchDeadLetterName },
];
