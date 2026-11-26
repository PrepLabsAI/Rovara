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
import { ATTENTION_EMAIL_FUNCTION_VARIABLE, coreAttentionEmailFunctionName, coreDispatchDeadLetterName, coreDispatchQueueName, coreLessonsReflectDeadLetterName, coreLessonsReflectQueueName, CORE_LESSONS_REFLECT_DEAD_LETTER_URL_VARIABLE, CORE_LESSONS_REFLECT_QUEUE_URL_VARIABLE, CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE, CORE_DISPATCH_QUEUE_URL_VARIABLE } from "./core-engine-infra.js";
import {
  environmentAlarmPrefix,
  environmentChannelAdapterSecretPrefix,
  environmentConnectorSecretPrefix,
  environmentE2eFeatureRuntimeCatalogId,
  environmentMetricsNamespace,
  githubWebhookSecretName,
  environmentProjectSetupRuntimeCatalogId,
  environmentSettingsPrefix,
} from "./environments.js";
import { brokerSettingsFromRows } from "./settings/derive.js";
import { INSTALL_ROWS } from "./settings/install-rows.js";

// The two variables below moved to settings/variables.ts (the install rows name them, and this file imports the rows); they are exported from here as before.
export { TEST_SERVICES_SETTING_VARIABLE, TEST_SERVICE_IMAGES_SETTING_VARIABLE } from "./settings/variables.js";

/** The variable the broker reads the dedicated GitHub webhook secret's name from (derived, DERIVED_BROKER_VARIABLES). */
export const GITHUB_WEBHOOK_SECRET_VARIABLE = "GITHUB_WEBHOOK_SECRET_ID";

/** The names the broker is given, as one variable. */
export const BROKER_NAMES_VARIABLE = "AGENTX_NAMES";
/** The constrained settings the broker is given, as one variable. */
export const BROKER_SETTINGS_VARIABLE = "AGENTX_SETTINGS";
/** The account the broker builds ARNs and queue URLs in (12 digits). The region is Lambda's own AWS_REGION. */
export const BROKER_ACCOUNT_VARIABLE = "AGENTX_ACCOUNT_ID";

/**
 * ENV-ROOM 2 (broker 4 KB, owner decision 2026-11-17): a named environment's AGENTX_NAMES is not in the function's environment at all. The control plane writes it to one SSM
 * String parameter (BROKER_NAMES_PARAMETER_VARIABLE names it; brokerNamesParameterName says which it must be) and gives the function the revision of what it wrote
 * (BROKER_NAMES_REVISION_VARIABLE). The parameter's value is `v1:<revision>:<the AGENTX_NAMES list>` (encodeBrokerNamesParameterPrefix, decodeBrokerNamesParameter).
 * The broker's handler (packages/broker/src/aws/broker-handler.ts) reads it before any broker module loads and refuses to start unless both revisions are the same, so a
 * function and a parameter from different deploys never run together. Only CloudFormation-generated names go there: they change only when the template replaces a resource,
 * and a name CloudFormation generates is never reused, so a stale one fails rather than pointing somewhere else. The settings (stack parameters an operator changes with
 * `agentx config set`) stay in AGENTX_SETTINGS: a change to them changes the function, so every running broker restarts with it. No secret is in the parameter.
 */
export const BROKER_NAMES_PARAMETER_VARIABLE = "AGENTX_NAMES_PARAMETER";
export const BROKER_NAMES_REVISION_VARIABLE = "AGENTX_NAMES_REVISION";
/** A revision: the sha256, in lowercase hex, of what the control plane writes (infra/lib/broker-names.ts). */
export const BROKER_NAMES_REVISION = /^[0-9a-f]{64}$/u;
/** The parameter a named environment's broker names are kept in. */
export function brokerNamesParameterName(env: string): string {
  return `${environmentSettingsPrefix(env)}broker-names`;
}
/** A Standard-tier String parameter's limit, which the parameter's worst case is held under (tests/contract/broker-names-parameter-infrastructure.test.ts). */
export const BROKER_NAMES_PARAMETER_MAX_BYTES = 4096;
const BROKER_NAMES_PARAMETER_FORMAT = "v1";

/** What the control plane writes before the list: the format and the revision. */
export function encodeBrokerNamesParameterPrefix(revision: string): string {
  if (!BROKER_NAMES_REVISION.test(revision)) throw new Error("a broker names revision is 64 lowercase hex digits");
  return `${BROKER_NAMES_PARAMETER_FORMAT}:${revision}:`;
}

/** The parameter's value, read: the revision it was written for and the AGENTX_NAMES list. Anything else is an error in fixed words, never a partial read. */
export function decodeBrokerNamesParameter(raw: string): { revision: string; list: string } | { error: string } {
  if (new TextEncoder().encode(raw).length > BROKER_NAMES_PARAMETER_MAX_BYTES) return { error: "is longer than a parameter can be" };
  const match = /^v1:([0-9a-f]{64}):([^\n]*)$/u.exec(raw);
  if (match === null) return { error: "is not in the v1 format" };
  return { revision: match[1]!, list: match[2]! };
}

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
  /** An HTTP API's id; the variable gets the control plane's sign-in issuer (`https://<id>.execute-api.<region>.amazonaws.com/v1/auth`, or `<ROVARA_PUBLIC_API_URL>/v1/auth` where the install has a public address). */
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

/** What a setting's value may be: letters, digits and `. _ : / -`, at most 127 characters, or empty; the slash preserves OpenRouter IDs. */
export const BROKER_SETTING_VALUE = /^[A-Za-z0-9._:/-]{0,127}$/u;

export interface BrokerSettingSpec {
  /** The key in AGENTX_SETTINGS: two letters. */
  readonly code: string;
  /** The variable the broker's code reads the value as. */
  readonly variable: string;
  /** The value is a host (with an optional port) and the variable gets its https origin, `https://<value>`; an empty value stays empty. Hosts stay bare; their https scheme is added here. */
  readonly httpsOrigin?: true;
  /**
   * DEC 254zg (a), 254zk (room in the broker's 4 KB): an on/off switch packed as one character, "1" or "0", which the variable gets as "enabled" or "disabled". Any other packed
   * value stops the broker (a flag read wrongly would turn a feature on or off without a word).
   */
  readonly switchFlag?: true;
}

/** A switch flag's packed value and the variable's value (BrokerSettingSpec.switchFlag). */
export const BROKER_SWITCH_FLAG_VALUES: Readonly<Record<string, "enabled" | "disabled">> = { "1": "enabled", "0": "disabled" };

/**
 * The broker's settings that are stack parameters already constrained to plain text (a Number, an AllowedValues list or an AllowedPattern without separators): the infrastructure
 * refuses any other. A free-text value (an issuer URL, JSON) does not belong here; it stays a variable of its own, or it is derived. Codes as in BROKER_NAMES: once each, never reused.
 */
export const BROKER_SETTINGS = brokerSettingsFromRows(INSTALL_ROWS) satisfies Record<string, BrokerSettingSpec>;


/** DEC 254z-amend3: the values of the TestServices stack parameter. "1" is on (the default); "0" is the owner's opt-out. The broker reads anything but exactly "0" as on. */
export const TEST_SERVICES_PARAMETER_VALUES = ["1", "0"] as const;
export const TEST_SERVICES_PARAMETER_DEFAULT = "1";
/** DEC 254zm: the values of the TestServiceImages stack parameter. `none` (the default): Code's workers do not run test services. `mirrored`: the operator copied and checked the five starter images (scripts/test-services-mirror.ts). */
export const TEST_SERVICE_IMAGES_PARAMETER_VALUES = ["none", "mirrored"] as const;
export const TEST_SERVICE_IMAGES_PARAMETER_DEFAULT = "none";
/** L4-SE: hosted saved environments stay off until their registry roles are provisioned. */
export const SAVED_ENVIRONMENTS_PARAMETER = "SavedEnvironments";
export const SAVED_ENVIRONMENTS_PARAMETER_DEFAULT = "0";
export const SAVED_ENVIRONMENTS_PARAMETER_VALUES = ["0", "1"] as const;

export type BrokerSettingKey = keyof typeof BROKER_SETTINGS;

/**
 * A variable the broker builds from the environment's name:
 *  - `text`: a string the name decides;
 *  - `queueUrl`: the URL of a queue with a fixed name (built with the region and the account).
 */
export type DerivedBrokerVariable =
  | { readonly variable: string; readonly kind: "text"; readonly value: (env: string) => string; readonly legacy?: true }
  | { readonly variable: string; readonly kind: "queueUrl"; readonly queueName: (env: string) => string; readonly legacy?: true };

/**
 * #1149: the legacy install (production, the un-named template) packs its broker's names and settings as a named environment does, with AGENTX_ENV=production, but its resources
 * are not named the way a named environment's are. So its broker derives only the variables marked `legacy`: those whose derivation for "production" is exactly the value the
 * legacy install has always passed (infra/lib/broker-names.ts checks it at synthesis), and (#1148) what the core engine brought there under the same fixed names: its dispatch and
 * lessons queues, the attention email's sender and the company reads. Every other derived variable is either passed whole by the legacy template or not set at all.
 */
export const LEGACY_INSTALL_LAYOUT = "legacy";

/** Every variable the broker derives. The infrastructure checks, at synthesis, that each `text` value is the one it would have passed (infra/lib/broker-names.ts). */
export const DERIVED_BROKER_VARIABLES: readonly DerivedBrokerVariable[] = [
  { variable: "CONNECTOR_SECRET_PREFIX", kind: "text", value: environmentConnectorSecretPrefix },
  { variable: "AGENTX_E2E_AGENT_SETTINGS_PREFIX", kind: "text", value: environmentSettingsPrefix },
  { variable: "AGENTX_ALARM_PREFIX", kind: "text", value: environmentAlarmPrefix },
  { variable: "AGENTX_METRICS_NAMESPACE", kind: "text", value: environmentMetricsNamespace },
  { variable: "AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID", kind: "text", value: environmentProjectSetupRuntimeCatalogId, legacy: true },
  { variable: "AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID", kind: "text", value: environmentE2eFeatureRuntimeCatalogId, legacy: true },
  // Core switch-on blocker (2026-11-17): the channel adapters' secret prefix is the environment's own, so it is derived, making room for the gateway settings.
  { variable: "CHANNEL_ADAPTER_SECRET_PREFIX", kind: "text", value: environmentChannelAdapterSecretPrefix, legacy: true },
  // Webhook lane W3: the dedicated GitHub webhook secret's NAME (a name only, never a value). The control-plane stack creates the secret under it, readable by the broker's role alone; the
  // broker's webhook receiver reads it and falls back to the App secret's webhookSecret key ONLY while the dedicated secret has no value. Derived: the broker's 4 KB grows by nothing.
  { variable: GITHUB_WEBHOOK_SECRET_VARIABLE, kind: "text", value: githubWebhookSecretName, legacy: true },
  // DEC 254h (room for GitHub sign-in): every named broker has the company reads on (infra/lib/developer-signin.ts, hosted wiring (d)); a named environment always deploys the
  // tasks, so the value is the same for every name, and the broker sets it itself. The legacy install, which is never packed, is given none, as before.
  { variable: "COMPANY_READS", kind: "text", value: () => "enabled", legacy: true },
  // Core switch-on lane L1a: the core dispatch queue and its dead letters have fixed names (core-engine-infra.ts), so the broker builds their URLs; nothing is passed.
  { variable: CORE_DISPATCH_QUEUE_URL_VARIABLE, kind: "queueUrl", queueName: coreDispatchQueueName, legacy: true },
  { variable: CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE, kind: "queueUrl", queueName: coreDispatchDeadLetterName, legacy: true },
  // L4-SQS (journey audit B3c): the lessons reflection queue and its dead letters, fixed names too (core-engine-infra.ts): derived, so the broker's 4 KB grows by nothing.
  { variable: CORE_LESSONS_REFLECT_QUEUE_URL_VARIABLE, kind: "queueUrl", queueName: coreLessonsReflectQueueName, legacy: true },
  { variable: CORE_LESSONS_REFLECT_DEAD_LETTER_URL_VARIABLE, kind: "queueUrl", queueName: coreLessonsReflectDeadLetterName, legacy: true },
  // Web task channel C8 (option b): the attention email's sender function has a fixed name, so the broker builds it; nothing is passed (the function exists only while the email is on).
  { variable: ATTENTION_EMAIL_FUNCTION_VARIABLE, kind: "text", value: coreAttentionEmailFunctionName, legacy: true },
];
