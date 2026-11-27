import {
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_dynamodb as dynamodb,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { METRICS_NAMESPACE_ROOT, PRODUCTION_SOURCE_KINDS_NAMED_REFUSAL, PRODUCTION_SOURCE_KINDS_REFUSAL, RESOURCE_PREFIX, environmentSettingsPrefix, parseSourceKindsSwitch, productionSourceKindsAllowed } from "./model-gateway-contracts.js";
import { applyCloudBoundary, byoCustomerAssumeConditions } from "./model-gateway-boundary.js";
import { GATEWAY_SERVICE_ARN_OUTPUT, addDeployedCodeSha } from "./model-gateway-deployed-sha.js";

/**
 * The Cloud model gateway's infrastructure (migration plan v3.2, 7.4; packages/model-gateway). Every model call of every task
 * passes through it, so it follows the availability rule of 7.5: two copies always, a release that never cuts a call, alarms.
 *
 *   worker (Code) --TLS--> load balancer (HTTPS only) --> 2+ Fargate tasks (GATEWAY_MODE=serve) --> api.anthropic.com
 *                                                              |  task token checked against Code's pinned JWKS
 *                                                              |  DynamoDB: meter (spend, holds), ledger (per-call records, pending-correction indexes),
 *                                                              |            markers (in-flight marker, ended tasks; expire),
 *                                                              |            prices (last good snapshot)
 *                                                              |  Secrets Manager: provider keys, read at run time
 *   EventBridge rule (daily) --> one Fargate task (GATEWAY_MODE=price-fetch) --> prices table
 *
 * Fargate, not Lambda: the gateway's entry is a node:http handler (server.ts createGatewayHandler) that streams one call for up
 * to an hour (provider.ts CALL_HARD_CEILING_MS), past Lambda's 15 minutes.
 *
 * Made only with `-c rovaraModelGateway=<environment>` (app.ts), never by the Cloud release pipeline, which deploys
 * RovaraCloudApp and RovaraCloudWeb by name. Two stacks:
 *  - ModelGatewayImagesStack: the image repository, deployed first so an image can be pushed before the service needs it;
 *  - ModelGatewayStack: everything else. Its parameters: CodeUrl (the one Code install trusted), CodeTaskKeyIds (the task-token
 *    key IDs Code's JWKS publishes, purpose=task; STAGING-KEY-PURPOSE-ORDER applies), CertificateArn (an existing ACM
 *    certificate for the gateway's name: this stack makes no certificate or DNS record), ImageDigest (the image to run,
 *    by digest) and CompanyTableName (the Cloud company backend's Companies table, read-only for budgets; its AWS-managed
 *    encryption key needs no grant).
 *
 * The literals shared with the process (environment names, table keys, log events) are in
 * packages/model-gateway/src/deploy.ts; tests/contract/model-gateway-infra.test.ts holds the two to one truth.
 */

export const MODEL_GATEWAY_CONTEXT_KEY = "rovaraModelGateway";
/**
 * `-c rovaraModelGatewayProductAi=on`, with `-c rovaraModelGateway=<env>`: the product-AI route (B5), the combined company cap
 * (B6), the shared eval stage table (B8), the learning route (#57) and Vertex federation (#58). Absent, the gateway template is
 * byte for byte what it was before (tests/contract/model-gateway-product-infra.test.ts pins it).
 */
export const MODEL_GATEWAY_PRODUCT_CONTEXT_KEY = "rovaraModelGatewayProductAi";
/**
 * Rovara's AI for agents (DEC 240), only with MODEL_GATEWAY_PRODUCT_CONTEXT_KEY on (company-key mode):
 * `-c rovaraModelGatewayRovaraAi=<agent model>=<bedrock id>,...` is the allow-list (GATEWAY_ROVARA_AI_MODELS), and
 * `-c rovaraModelGatewayRovaraAiExempt=<org id>,...` the operator's explicit list of companies exempt from charges (the founders'
 * test company, DEC 240b). Production may carry the models (Rovara-cloud#247), never exempt companies. Absent: the template is exactly as without it.
 */
export const MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY = "rovaraModelGatewayRovaraAi";
export const MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY = "rovaraModelGatewayRovaraAiExempt";
/**
 * `-c rovaraModelGatewayRovaraAiDisabled=<model>,...`: models Rovara's AI lists but does not offer a company's agents yet
 * (GATEWAY_AGENT_MODELS_DISABLED; "" holds none back). Absent: the gateway's default (Sonnet 5.5, Opus 5.5 and Fable 5.2 until the
 * account's one-time Marketplace enable), and the template is exactly as without it.
 */
export const MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY = "rovaraModelGatewayRovaraAiDisabled";
/**
 * DEC 254zzz96 (2): `-c rovaraModelGatewayOfferedPrices=on` publishes each offered model's list price (GATEWAY_OFFERED_PRICES=on) for the company's
 * step models card. Turn it on only once the Code install's release accepts the optional price field. Absent: the template is exactly as without it.
 */
export const MODEL_GATEWAY_OFFERED_PRICES_CONTEXT_KEY = "rovaraModelGatewayOfferedPrices";
/**
 * How the provider key secrets are named. Absent (or "generated"): CloudFormation generates each secret's name, so a stack that
 * failed on create and was deleted can be made again (a deleted secret keeps its NAME reserved for its recovery window, which
 * blocks a re-create under a fixed name). `-c rovaraModelGatewayProviderSecretNames=fixed`: the original fixed name
 * rovara-cloud/<env>/model-gateway/provider/<provider>. An environment ALREADY deployed with the fixed names MUST keep passing
 * "fixed": changing a secret's name replaces it, and the replacement starts as a placeholder (the old secret, with the real
 * key, is retained but no longer read). See docs/rovara-cloud-install.md, "The gateway's provider keys".
 */
export const MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY = "rovaraModelGatewayProviderSecretNames";
/** Every customer role's name starts with this (packages/model-gateway bedrock-byo.ts BEDROCK_BYO_ROLE_PREFIX; a test pins them). */
export const BEDROCK_BYO_CUSTOMER_ROLE_PREFIX = "RovaraBedrockInvoke-";
/** The broker role's FIXED name: every customer's trust policy names it, so it must never change or be re-created. */
export const bedrockBrokerRoleName = (env: string) => `RovaraBedrockBroker-${env}`;
/** The external-id key's FIXED alias (the same reason: a replaced key would change every company's external id). */
export const bedrockExternalIdKeyAlias = (env: string) => `alias/rovara-bedrock-external-id-${env}`;
/**
 * The Regions a system inference profile of each geography sends calls to (bedrock get-inference-profile, staging us-west-2,
 * 2026-11-15: every us. Claude profile lists us-east-1, us-east-2 and us-west-2). Invoking through a profile needs the
 * foundation-model ARN in each of them; the grant allows those ONLY through the named profiles (bedrock:InferenceProfileArn).
 */
/** DEC 243: `-c rovaraModelGatewayRovaraAi=on` offers these (the gateway's agent-ai.ts ROVARA_AI_US_MODELS; a contract test holds them equal). */
export const ROVARA_AI_US_MODELS = [
  "claude-haiku-4-5=us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-haiku-4-5-20251001=us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-haiku-5-5=us.anthropic.claude-haiku-5-5",
  "claude-sonnet-5-5=us.anthropic.claude-sonnet-5-5",
  "claude-opus-5-5=us.anthropic.claude-opus-5-5",
  "claude-fable-5-2=us.anthropic.claude-fable-5-2",
].join(",");
/** DEC 243c: the other Bedrock coding models `on` also offers (the gateway's agent-ai.ts ROVARA_AI_US_CONVERSE_MODELS; a contract test holds them equal). */
export const ROVARA_AI_US_CONVERSE_MODELS = [
  "qwen.qwen3-coder-480b-a35b-v1:0=qwen.qwen3-coder-480b-a35b-v1:0",
  "qwen.qwen3-coder-30b-a3b-v1:0=qwen.qwen3-coder-30b-a3b-v1:0",
  "qwen.qwen3-235b-a22b-2507-v1:0=qwen.qwen3-235b-a22b-2507-v1:0",
  "mistral.devstral-2-123b=mistral.devstral-2-123b",
  "mistral.mistral-large-3-675b-instruct=mistral.mistral-large-3-675b-instruct",
  "deepseek.v3-v1:0=deepseek.v3-v1:0",
  "moonshotai.kimi-k2.5=moonshotai.kimi-k2.5",
  "zai.glm-5=zai.glm-5",
  "zai.glm-4.7=zai.glm-4.7",
  "us.amazon.nova-2-lite-v1:0=us.amazon.nova-2-lite-v1:0",
  "openai.gpt-oss-120b-1:0=openai.gpt-oss-120b-1:0",
  "openai.gpt-oss-20b-1:0=openai.gpt-oss-20b-1:0",
  "us.amazon.nova-pro-v1:0=us.amazon.nova-pro-v1:0",
  "moonshot.kimi-k2-thinking=moonshot.kimi-k2-thinking",
  "minimax.minimax-m2.5=minimax.minimax-m2.5",
  "us.moonshotai.kimi-k3=us.moonshotai.kimi-k3",
  "us.moonshotai.kimi-k3.1=us.moonshotai.kimi-k3.1",
  // deepseek.v3.2 stays unlisted: in the real two-turn call (2026-11-16) turn 1 ended end_turn with no tool call and no thinking.
].join(",");
export const ROVARA_AI_PROFILE_REGIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({ us: ["us-east-1", "us-east-2", "us-west-2"] });
const ROVARA_AI_AGENT_MODEL = /^claude-[a-z0-9-]{1,80}$/u;
const ROVARA_AI_BEDROCK_ID = /^([a-z]{2,4})\.(anthropic\.claude-[a-z0-9-]{1,80}(?::\d{1,3})?)$/u;
const ROVARA_AI_COMPANY = /^org_[0-9a-z]{20}$/u;
export interface RovaraAiProps { readonly models: string; readonly exempt?: string; readonly disabled?: string }
/** The allow-list's Bedrock ids, checked as the process checks them (agent-ai.ts parseRovaraAiModels; a contract test holds the two together). */
/** DEC 243c: any other model, called through Converse: `<provider>.<model>` in this Region, or its `<geo>.` profile (bedrock-converse.ts BEDROCK_CONVERSE_ID). */
const ROVARA_AI_CONVERSE_ID = /^(?!global\.)(?!(?:(?:us|eu|apac|jp|au|ca)\.)?anthropic\.)(?:(us|eu|apac|jp|au|ca)\.)?([a-z][a-z0-9-]{1,30}\.[a-z0-9][a-z0-9.:-]{0,100})$/u;
export function rovaraAiModelIds(models: string, region: string): Array<{ id: string; geography?: string; model: string }> {
  const pairs = models.split(",").map((pair) => pair.trim());
  const names = new Set<string>();
  if (models.trim() === "" || pairs.length > 24) throw new Error(`${MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY}: give <agent model>=<bedrock id> pairs`);
  return pairs.map((pair) => {
    const [name, id, extra] = pair.split("=");
    const converse = id === undefined || ROVARA_AI_BEDROCK_ID.test(id) ? null : ROVARA_AI_CONVERSE_ID.exec(id);
    if (converse !== null && name !== undefined && extra === undefined && !names.has(name) && name === id) {
      names.add(name);
      const geography = converse[1];
      if (geography !== undefined && (ROVARA_AI_PROFILE_REGIONS[geography] === undefined || !ROVARA_AI_PROFILE_REGIONS[geography].includes(region))) throw new Error(`${MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY}: ${id} is not a profile of ${region}'s geography`);
      return { id, model: converse[2]!, ...(geography === undefined ? {} : { geography }) };
    }
    const match = id === undefined ? null : ROVARA_AI_BEDROCK_ID.exec(id);
    if (name === undefined || extra !== undefined || !ROVARA_AI_AGENT_MODEL.test(name) || names.has(name) || match === null) throw new Error(`${MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY}: give <agent model>=<bedrock id> pairs`);
    names.add(name);
    // The pattern requires the geography prefix: profiles only (DEC 243).
    const geography = match[1]!;
    // Profiles only (DEC 243), of the gateway's own Region's geography (no global routing), and only a geography whose Regions are known.
    if (ROVARA_AI_PROFILE_REGIONS[geography] === undefined || !ROVARA_AI_PROFILE_REGIONS[geography].includes(region)) throw new Error(`${MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY}: ${id} is not a profile of ${region}'s geography`);
    return { id: id!, model: match[2]!, geography };
  });
}

/** Both validate the name first (the environment rules), so a bad name fails with that message, not CloudFormation's. */
export function modelGatewayStackName(env: string): string {
  environmentSettingsPrefix(env);
  return `${RESOURCE_PREFIX}-${env}-gateway`;
}
export function modelGatewayImagesStackName(env: string): string {
  environmentSettingsPrefix(env);
  return `${RESOURCE_PREFIX}-${env}-gateway-images`;
}

/** Repeated from packages/model-gateway/src/deploy.ts (infra does not depend on the gateway package); the contract test pins them. */
export const MODEL_GATEWAY_ENV = {
  mode: "GATEWAY_MODE",
  port: "GATEWAY_PORT",
  installIssuer: "GATEWAY_INSTALL_ISSUER",
  installJwksUrl: "GATEWAY_INSTALL_JWKS_URL",
  installTaskKids: "GATEWAY_INSTALL_TASK_KIDS",
  meterTable: "GATEWAY_METER_TABLE",
  ledgerTable: "GATEWAY_LEDGER_TABLE",
  markersTable: "GATEWAY_MARKERS_TABLE",
  pricesTable: "GATEWAY_PRICES_TABLE",
  anthropicKeySecret: "GATEWAY_ANTHROPIC_KEY_SECRET",
  companyTable: "GATEWAY_COMPANY_TABLE",
  productKeysTable: "GATEWAY_PRODUCT_KEYS_TABLE",
  productKeysKey: "GATEWAY_PRODUCT_KEYS_KEY",
  productMeterTable: "GATEWAY_PRODUCT_METER_TABLE",
  productLedgerTable: "GATEWAY_PRODUCT_LEDGER_TABLE",
  productMarkersTable: "GATEWAY_PRODUCT_MARKERS_TABLE",
  evalStagesTable: "GATEWAY_EVAL_STAGES_TABLE",
  vertexFederationRole: "GATEWAY_VERTEX_FEDERATION_ROLE",
  productMacKey: "GATEWAY_PRODUCT_MAC_KEY",
  learningMeterTable: "GATEWAY_LEARNING_METER_TABLE",
  learningLedgerTable: "GATEWAY_LEARNING_LEDGER_TABLE",
  learningMarkersTable: "GATEWAY_LEARNING_MARKERS_TABLE",
  answersMeterTable: "GATEWAY_ANSWERS_METER_TABLE",
  answersLedgerTable: "GATEWAY_ANSWERS_LEDGER_TABLE",
  answersMarkersTable: "GATEWAY_ANSWERS_MARKERS_TABLE",
  agentKeys: "GATEWAY_AGENT_KEYS",
  rovaraAiSourceId: "GATEWAY_ROVARA_AI_SOURCE_ID",
  rovaraAiModels: "GATEWAY_ROVARA_AI_MODELS",
  rovaraAiExempt: "GATEWAY_ROVARA_AI_EXEMPT",
  agentModelsDisabled: "GATEWAY_AGENT_MODELS_DISABLED",
  bedrockBrokerRole: "GATEWAY_BEDROCK_BROKER_ROLE",
  bedrockExternalIdKey: "GATEWAY_BEDROCK_EXTERNAL_ID_KEY",
  aiSourceKinds: "GATEWAY_AI_SOURCE_KINDS",
  offeredPrices: "GATEWAY_OFFERED_PRICES",
} as const;
/** The eval stage table's due-stages index (deploy.ts GATEWAY_EVAL_STAGE_INDEXES). */
export const MODEL_GATEWAY_EVAL_STAGE_INDEXES = {
  dueStages: { name: "due-stages", partitionKey: "dueAll", sortKey: "dueAt" },
} as const;
/** The KMS encryption context a sealed product key is bound to (product-seal.ts productKeyContext), and its purpose. */
export const PRODUCT_KEY_PURPOSE = "rovara-product-ai-key";
export const PRODUCT_KEY_CONTEXT_KEYS = ["purpose", "install", "company", "owner", "source", "version"] as const;
export const MODEL_GATEWAY_PORT = 8080;
export const MODEL_GATEWAY_COMPANY_KEY_PREFIX = "CO#";
export const MODEL_GATEWAY_MARKERS_TTL_ATTRIBUTE = "expiresAt";
/** The ledger's pending-correction indexes (deploy.ts GATEWAY_LEDGER_INDEXES): sparse, string keys, every attribute projected. */
export const MODEL_GATEWAY_LEDGER_INDEXES = {
  pendingByKey: { name: "pending-by-key", partitionKey: "pendingAll", sortKey: "pendingKeyAt" },
  pendingByAge: { name: "pending-by-age", partitionKey: "pendingAll", sortKey: "pendingAt" },
} as const;
export const MODEL_GATEWAY_LOG_EVENTS = {
  refused: "refused",
  overrunBusy: "overrun_busy",
  openRouterOverReservation: "openrouter_over_reservation",
  settleFailed: "settle_failed",
  providerError: "provider_error",
  priceFetchFailed: "price_fetch_failed",
  priceFetched: "price_fetched",
} as const;
/** The meter's open-holds index (deploy.ts GATEWAY_METER_INDEXES), read by the sweep of holds whose settle failed. */
export const MODEL_GATEWAY_METER_INDEXES = {
  openHolds: { name: "open-holds", partitionKey: "openAll", sortKey: "openAt" },
} as const;
/** The Cloud company backend's Companies table keys (deploy.ts GATEWAY_COMPANY_SETTINGS). */
export const MODEL_GATEWAY_COMPANY_PARTITION_PREFIX = "COMPANY#";

/** The providers whose keys the gateway holds; one secret each. Only the Anthropic Messages route exists (R3a). */
export const MODEL_GATEWAY_PROVIDERS = ["anthropic"] as const;
/** Always at least this many copies serving (plan 7.5: two tasks). */
export const MODEL_GATEWAY_MIN_TASKS = 2;
/** One call may stream for up to an hour (provider.ts CALL_HARD_CEILING_MS): a release lets open calls finish, and the load
 * balancer does not cut a quiet stream before it. */
export const MODEL_GATEWAY_CALL_CEILING_SECONDS = 3600;
/** Daily, at 06:00 UTC (R3c REFRESH_INTERVAL_MS is 24 h). */
export const MODEL_GATEWAY_PRICE_FETCH_SCHEDULE = "cron(0 6 * * ? *)";
export const MODEL_GATEWAY_METRICS_NAMESPACE = `${METRICS_NAMESPACE_ROOT}/ModelGateway`;
/** Alarm thresholds (first guesses; tune from staging). Five-minute sums unless said. */
export const MODEL_GATEWAY_ALARMS = {
  target5xx: 10,
  loadBalancer5xx: 1,
  refusals: 50,
  busy: 20,
  settleFailed: 1,
  /** One hour. */
  priceFetchFailed: 1,
  /** No saved price fetch for this many days in a row (R3c STALE_ALARM_MS is three days). */
  priceStaleDays: 3,
} as const;

/** The version ID Secrets Manager puts in the context of its key-access check (Secrets Manager encryption guide). */
export const VALIDATE_KEY_ACCESS_VERSION = "RequestToValidateKeyAccess";

export function providerSecretName(env: string, provider: string): string {
  return `${RESOURCE_PREFIX}/${env}/model-gateway/provider/${provider}`;
}

/** Reads MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY: absent is "generated"; anything but "generated" or "fixed" is refused. */
export function providerSecretNamesMode(value: unknown): "generated" | "fixed" {
  if (value === undefined || value === "generated") return "generated";
  if (value === "fixed") return "fixed";
  throw new Error(`${MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY} must be "fixed" or "generated" (or absent, which is "generated")`);
}

export interface ModelGatewayImagesProps extends StackProps {
  readonly environmentName: string;
}

/** The gateway's image repository: immutable tags, scanned on push, kept. */
export class ModelGatewayImagesStack extends Stack {
  readonly repository: ecr.IRepository;

  constructor(scope: Construct, id: string, props: ModelGatewayImagesProps) {
    super(scope, id, props);
    environmentSettingsPrefix(props.environmentName);
    const repository = new ecr.Repository(this, "Images", {
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ description: "keep the last 50 images", maxImageCount: 50 }],
    });
    this.repository = repository;
    new CfnOutput(this, "RepositoryUri", { value: repository.repositoryUri, description: "Push the gateway image here; deploy the gateway stack with its digest" });
    // Last, so the template keeps its section order; the aspect puts it on every role at synth (model-gateway-boundary.ts).
    applyCloudBoundary(this, props.environmentName, "gateway-images");
  }
}

export interface ModelGatewayProps extends StackProps {
  /** The named cloud environment, for example "staging" (at most 14 characters, the environment rules). */
  readonly environmentName: string;
  readonly repository: ecr.IRepository;
  /** The product-AI, learning and Vertex additions (MODEL_GATEWAY_PRODUCT_CONTEXT_KEY). Default off. */
  readonly productAi?: boolean;
  /** Rovara's AI for agents (MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY). Needs productAi. Default off. */
  readonly rovaraAi?: RovaraAiProps;
  /** DEC 254t: the switched-on company AI source kinds (app.ts AI_SOURCE_KINDS_CONTEXT_KEY, checked there). Needs productAi. Absent: not set (none). */
  readonly aiSourceKinds?: string;
  /** DEC 254zzz96 (2): publish list prices on the offered-models answer. Absent: off. */
  readonly offeredPrices?: boolean;
  /**
   * "fixed" keeps the provider secrets at their original fixed names (an environment deployed that way must keep it); the default
   * lets CloudFormation generate them (MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY).
   */
  readonly providerSecretNames?: "fixed" | "generated";
}

/** Table defaults: on-demand, point-in-time recovery, deletion protection, kept if the stack goes. */
function table(scope: Construct, id: string, ttl: boolean, indexes: readonly dynamodb.GlobalSecondaryIndexPropsV2[] = []): dynamodb.TableV2 {
  return new dynamodb.TableV2(scope, id, {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
    ...(ttl ? { timeToLiveAttribute: MODEL_GATEWAY_MARKERS_TTL_ATTRIBUTE } : {}),
    ...(indexes.length === 0 ? {} : { globalSecondaryIndexes: [...indexes] }),
    billing: dynamodb.Billing.onDemand(),
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    deletionProtection: true,
    removalPolicy: RemovalPolicy.RETAIN,
  });
}

export class ModelGatewayStack extends Stack {
  constructor(scope: Construct, id: string, props: ModelGatewayProps) {
    super(scope, id, props);
    const env = props.environmentName;
    environmentSettingsPrefix(env);

    const codeUrl = new CfnParameter(this, "CodeUrl", {
      type: "String",
      allowedPattern: "^https://[^/\\s]+$",
      constraintDescription: "the Rovara Code install's API address: https:// and a host, no path",
      description: "The one Rovara Code install whose task tokens the gateway accepts (its issuer is <CodeUrl>/v1/auth)",
    });
    const taskKeyIds = new CfnParameter(this, "CodeTaskKeyIds", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9_-]{16}(,[A-Za-z0-9_-]{16})?$",
      constraintDescription: "one or two 16-character key IDs, comma-separated",
      description: "The kid of Code's task-token key (purpose=task) in its JWKS; a second during rotation. Never the sign-in key's kid",
    });
    const certificateArn = new CfnParameter(this, "CertificateArn", {
      type: "String",
      allowedPattern: "^arn:aws[a-z-]*:acm:[a-z0-9-]+:[0-9]{12}:certificate/[0-9a-f-]{36}$",
      constraintDescription: "an ACM certificate ARN in this region",
      description: "An existing ACM certificate for the gateway's name (this stack makes no certificate or DNS record)",
    });
    const imageDigest = new CfnParameter(this, "ImageDigest", {
      type: "String",
      allowedPattern: "^sha256:[0-9a-f]{64}$",
      constraintDescription: "an image digest, sha256:<64 hex>",
      description: "The gateway image to run, by digest, from the gateway-images stack's repository",
    });
    const companyTableName = new CfnParameter(this, "CompanyTableName", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9_.-]{3,255}$",
      constraintDescription: "a DynamoDB table name",
      description: "The Cloud company backend's Companies table (RovaraCloudWeb output CompanyTableName): the gateway reads each company's budgets from it",
    });
    const issuer = `${codeUrl.valueAsString}/v1/auth`;

    // Tables. Only markers expire (DEC 222: spend, holds and per-call records are kept).
    // The meter's open holds, as one sparse index: the sweep closes holds whose settle failed.
    const meter = table(this, "Meter", false, Object.values(MODEL_GATEWAY_METER_INDEXES).map((index) => ({
      indexName: index.name,
      partitionKey: { name: index.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: index.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    })));
    // The ledger's estimated calls waiting for a real price (R3c's pending-correction index), as two sparse indexes.
    const ledger = table(this, "Ledger", false, Object.values(MODEL_GATEWAY_LEDGER_INDEXES).map((index) => ({
      indexName: index.name,
      partitionKey: { name: index.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: index.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    })));
    const markers = table(this, "Markers", true);
    const prices = table(this, "Prices", false);

    // Provider keys: one secret each, encrypted with a key whose policy grants decrypt of a stored value to the serving task's
    // role only (through Secrets Manager). Not a boundary against an account principal holding kms:PutKeyPolicy or
    // iam:PassRole on that role: those stay administrator rights. The value starts as a placeholder; an operator stores the
    // real key with `aws secretsmanager put-secret-value` (a new version; the console's edit reads the value first and is
    // refused), naming the secret by the ARN in the ProviderKeySecrets output (or its fixed name; see
    // MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY).
    const serveRole = new iam.Role(this, "ServeTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com", {
        conditions: { ArnLike: { "aws:SourceArn": `arn:${this.partition}:ecs:${this.region}:${this.account}:*` }, StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: `Rovara Cloud ${env}: the model gateway's serving tasks`,
    });
    const executionRole = (id: string, what: string) => new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com", {
        conditions: { ArnLike: { "aws:SourceArn": `arn:${this.partition}:ecs:${this.region}:${this.account}:*` }, StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: `Rovara Cloud ${env}: pulls the model gateway image and writes the ${what} logs`,
    });
    const fetchRole = new iam.Role(this, "PriceFetchTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com", {
        conditions: { ArnLike: { "aws:SourceArn": `arn:${this.partition}:ecs:${this.region}:${this.account}:*` }, StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: `Rovara Cloud ${env}: the model gateway's daily price fetch`,
    });
    const viaSecretsManager = `secretsmanager.${this.region}.amazonaws.com`;
    const fixedSecretNames = (props.providerSecretNames ?? "generated") === "fixed";
    // Fixed names: the key policy names the secrets' prefix. Generated names are unknown until the secrets exist, and the secrets
    // name this key (a policy naming them would be circular), so the pattern is every secret in this account and Region. That
    // adds no read: decrypt of a stored value is still the serving role's alone (OnlyGatewayReads), and the serving role is
    // granted GetSecretValue on the provider secrets' ARNs only. It lets an operator store a value in another secret made with
    // this key, which they cannot read back.
    const secretArnPattern = fixedSecretNames
      ? `arn:${this.partition}:secretsmanager:${this.region}:${this.account}:secret:${providerSecretName(env, "")}*`
      : `arn:${this.partition}:secretsmanager:${this.region}:${this.account}:secret:*`;
    const providerKeysKey = new kms.Key(this, "ProviderKeysKey", {
      description: `Rovara Cloud ${env}: encrypts the model gateway's provider keys; only the gateway's serving role decrypts`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: "AccountManagesNotUses",
            principals: [new iam.AccountRootPrincipal()],
            actions: [
              // Not kms:CreateGrant (nor Create*): a grant would let the account give itself use of the key.
              "kms:CreateAlias", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*",
              "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:RotateKeyOnDemand",
            ],
            resources: ["*"],
          }),
          new iam.PolicyStatement({
            sid: "OperatorsStoreNotRead",
            principals: [new iam.AccountRootPrincipal()],
            actions: ["kms:GenerateDataKey", "kms:Encrypt"],
            resources: ["*"],
            conditions: { StringEquals: { "kms:ViaService": viaSecretsManager }, StringLike: { "kms:EncryptionContext:SecretARN": secretArnPattern } },
          }),
          // Secrets Manager checks a new key with a GenerateDataKey + Decrypt whose context names the version
          // "RequestToValidateKeyAccess" (CreateSecret needs both, as the deploying principal). That Decrypt opens no real
          // version: every stored version is bound to its own version ID in the encryption context.
          new iam.PolicyStatement({
            sid: "ValidateKeyAccessOnly",
            principals: [new iam.AccountRootPrincipal()],
            actions: ["kms:Decrypt"],
            resources: ["*"],
            conditions: {
              StringEquals: { "kms:ViaService": viaSecretsManager, "kms:EncryptionContext:SecretVersionId": VALIDATE_KEY_ACCESS_VERSION },
              StringLike: { "kms:EncryptionContext:SecretARN": secretArnPattern },
            },
          }),
          // By the role's ARN as a condition, not as a principal: no wait on a just-made role, and a replaced role keeps access.
          new iam.PolicyStatement({
            sid: "OnlyGatewayReads",
            principals: [new iam.AccountRootPrincipal()],
            actions: ["kms:Decrypt"],
            resources: ["*"],
            conditions: {
              StringEquals: { "kms:ViaService": viaSecretsManager },
              StringLike: { "kms:EncryptionContext:SecretARN": secretArnPattern },
              ArnEquals: { "aws:PrincipalArn": serveRole.roleArn },
            },
          }),
        ],
      }),
    });
    // L1 on purpose: the L2 Secret adds kms:Decrypt for the whole account (through Secrets Manager) to the key's policy, which
    // would let any account principal with secretsmanager:GetSecretValue read the keys.
    const secrets = MODEL_GATEWAY_PROVIDERS.map((provider) => {
      const secret = new secretsmanager.CfnSecret(this, `ProviderKey-${provider}`, {
        // No name: CloudFormation generates one (the default; see MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY).
        ...(fixedSecretNames ? { name: providerSecretName(env, provider) } : {}),
        description: `Rovara Cloud ${env}: the model gateway's ${provider} key. Starts as a placeholder; put the real key here before switching the gateway on.`,
        kmsKeyId: providerKeysKey.keyArn,
        generateSecretString: { passwordLength: 32, excludePunctuation: true },
      });
      secret.applyRemovalPolicy(RemovalPolicy.RETAIN);
      // What the operator names to store the key: the fixed name, or (generated names) the secret's ARN, which Ref returns.
      return { secretArn: secret.ref, secretId: fixedSecretNames ? providerSecretName(env, provider) : secret.ref };
    });
    const anthropic = secrets[0]!;

    // The serving role: exactly these tables and secrets, company keys only on the company tables, no deletes of money rows.
    const companyKeysOnly = {
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${MODEL_GATEWAY_COMPANY_KEY_PREFIX}*`] },
      Null: { "dynamodb:LeadingKeys": "false" },
    };
    // Transactions are authorised per item action (Put/Update/ConditionCheck), so these cover TransactWriteItems too.
    const moneyActions = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"];
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "MeterAndLedgerCompanyKeys", actions: moneyActions, resources: [meter.tableArn, ledger.tableArn], conditions: companyKeysOnly }));
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "MarkersCompanyKeys", actions: [...moneyActions, "dynamodb:DeleteItem"], resources: [markers.tableArn], conditions: companyKeysOnly }));
    // The correction run (in the serving tasks) finds pending calls across companies through the ledger's two indexes:
    // Query only, those two indexes by name. Their partition is one constant, not a company key, so no LeadingKeys
    // condition; the rows they return are the ones the company-keys grant above already lets this role read.
    serveRole.addToPolicy(new iam.PolicyStatement({
      sid: "QueryPendingCorrections", actions: ["dynamodb:Query"],
      resources: Object.values(MODEL_GATEWAY_LEDGER_INDEXES).map((index) => `${ledger.tableArn}/index/${index.name}`),
    }));
    // The hold sweep: Query only, the meter's open-holds index by name (same reasoning as the pending indexes).
    serveRole.addToPolicy(new iam.PolicyStatement({
      sid: "QueryOpenHolds", actions: ["dynamodb:Query"],
      resources: Object.values(MODEL_GATEWAY_METER_INDEXES).map((index) => `${meter.tableArn}/index/${index.name}`),
    }));
    // Budgets: read only, one company's settings row at a time (the backend's COMPANY# keys), from its Companies table.
    serveRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadCompanyBudgets", actions: ["dynamodb:GetItem"],
      resources: [`arn:${this.partition}:dynamodb:${this.region}:${this.account}:table/${companyTableName.valueAsString}`],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${MODEL_GATEWAY_COMPANY_PARTITION_PREFIX}*`] }, Null: { "dynamodb:LeadingKeys": "false" } },
    }));
    // DEC 328: a reserved single-record partition, not a company. No query, scan or write.
    serveRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadInstallRovaraAi", actions: ["dynamodb:GetItem"],
      resources: [`arn:${this.partition}:dynamodb:${this.region}:${this.account}:table/${companyTableName.valueAsString}`],
      conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["INSTALL#ROVARA_AI"] }, Null: { "dynamodb:LeadingKeys": "false" } },
    }));
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadPrices", actions: ["dynamodb:GetItem", "dynamodb:Query"], resources: [prices.tableArn] }));
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadProviderKeys", actions: ["secretsmanager:GetSecretValue"], resources: secrets.map((secret) => secret.secretArn) }));
    serveRole.addToPolicy(new iam.PolicyStatement({
      sid: "DecryptProviderKeys", actions: ["kms:Decrypt"], resources: [providerKeysKey.keyArn],
      conditions: { StringEquals: { "kms:ViaService": viaSecretsManager } },
    }));
    // The price job: the prices table only (no meter, no ledger, no keys). Corrections run in the serving tasks.
    fetchRole.addToPolicy(new iam.PolicyStatement({ sid: "WritePrices", actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [prices.tableArn] }));

    // Production carries Rovara's AI (Rovara-cloud#247), but never the operator's exempt companies (charge-free use, a test-company setting).
    if (props.rovaraAi?.exempt !== undefined && env === "production") throw new Error("Rovara's AI exempt companies are for named test environments, never production");
    const product = props.productAi === true ? this.productAi(env, issuer, serveRole, moneyActions, companyKeysOnly) : undefined;
    const rovaraAi = props.rovaraAi === undefined ? undefined : this.rovaraAi(props.rovaraAi, product !== undefined, serveRole);
    // Bring your own Bedrock (DEC 238, DEC 254zzz520): no switch. With product AI (company-key mode) the gateway always carries the retained
    // broker role and the external-id key; a company's saved, sealed role is what turns it on for that company (none saved: 404 not_set_up).
    const bedrockByo = product === undefined ? undefined : this.bedrockByo(env, serveRole);
    // DEC 254t: company-key mode only (product AI). Rovara-cloud#308: production may switch on only PRODUCTION_SOURCE_KINDS (OpenAI).
    if (props.aiSourceKinds !== undefined && product === undefined) throw new Error("company AI source kinds need the product AI additions (rovaraModelGatewayProductAi=on)");
    if (env === "production" && !productionSourceKindsAllowed(props.aiSourceKinds)) throw new Error(PRODUCTION_SOURCE_KINDS_REFUSAL);
    // DEC 254zzz520: an install that names NO kinds keeps own Bedrock for the AGENTS on (agent-ai.ts PRE_SWITCH_ONLY_WITHOUT_KINDS), and production carries the
    // broker role whenever product AI is on: so a production deploy must name its kinds (the release pipeline always does, with "openai").
    if (env === "production" && product !== undefined && parseSourceKindsSwitch(props.aiSourceKinds).length === 0) throw new Error(PRODUCTION_SOURCE_KINDS_NAMED_REFUSAL);
    const openRouterEnabled = parseSourceKindsSwitch(props.aiSourceKinds).includes("openrouter");

    // Network: two zones, public subnets and no NAT gateway. Tasks take only the load balancer's traffic; DynamoDB through a
    // gateway endpoint.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      gatewayEndpoints: { DynamoDb: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB } },
      // aws-cdk-lib's optional members don't satisfy exactOptionalPropertyTypes for IVpc / ICluster / ITaskDefinition (as cloud-web.ts).
    }) as ec2.IVpc;
    const albGroup = new ec2.SecurityGroup(this, "LoadBalancerGroup", { vpc, allowAllOutbound: false, description: "model gateway load balancer: HTTPS in, to the tasks out" });
    albGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "workers call the gateway over TLS");
    const taskGroup = new ec2.SecurityGroup(this, "TaskGroup", { vpc, allowAllOutbound: false, description: "model gateway tasks: the load balancer in, HTTPS out" });
    taskGroup.addIngressRule(albGroup, ec2.Port.tcp(MODEL_GATEWAY_PORT), "from the load balancer only");
    albGroup.addEgressRule(taskGroup, ec2.Port.tcp(MODEL_GATEWAY_PORT), "to the tasks");
    taskGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "providers, JWKS from Code, AWS APIs, the image registry");
    const fetchGroup = new ec2.SecurityGroup(this, "PriceFetchGroup", { vpc, allowAllOutbound: false, description: "model gateway price fetch: HTTPS out only" });
    fetchGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "price sources, AWS APIs, the image registry");

    const cluster = new ecs.Cluster(this, "Cluster", { vpc }) as ecs.ICluster;
    const image = ecs.ContainerImage.fromRegistry(props.repository.repositoryUriForDigest(imageDigest.valueAsString));
    const shared = { [MODEL_GATEWAY_ENV.pricesTable]: prices.tableName, NODE_OPTIONS: "--enable-source-maps" };

    const serveLogs = new logs.LogGroup(this, "ServeLogs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });
    const serveTask = new ecs.FargateTaskDefinition(this, "ServeTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      taskRole: serveRole,
      executionRole: executionRole("ServeExecutionRole", "serving"),
    });
    serveTask.addContainer("gateway", {
      image,
      essential: true,
      readonlyRootFilesystem: true,
      user: "1000:1000",
      portMappings: [{ containerPort: MODEL_GATEWAY_PORT }],
      stopTimeout: Duration.seconds(120),
      logging: ecs.LogDrivers.awsLogs({ logGroup: serveLogs, streamPrefix: "serve" }),
      // Plain settings only: no `secrets` here (ECS would put the value in the environment). The process reads the key by ARN.
      environment: {
        ...shared,
        [MODEL_GATEWAY_ENV.mode]: "serve",
        [MODEL_GATEWAY_ENV.port]: String(MODEL_GATEWAY_PORT),
        [MODEL_GATEWAY_ENV.installIssuer]: issuer,
        // Pinned here, never taken from a token (TC-1: <iss>/.well-known/jwks.json).
        [MODEL_GATEWAY_ENV.installJwksUrl]: `${issuer}/.well-known/jwks.json`,
        [MODEL_GATEWAY_ENV.installTaskKids]: taskKeyIds.valueAsString,
        [MODEL_GATEWAY_ENV.meterTable]: meter.tableName,
        [MODEL_GATEWAY_ENV.ledgerTable]: ledger.tableName,
        [MODEL_GATEWAY_ENV.markersTable]: markers.tableName,
        [MODEL_GATEWAY_ENV.anthropicKeySecret]: anthropic.secretArn,
        [MODEL_GATEWAY_ENV.companyTable]: companyTableName.valueAsString,
        ...(product === undefined ? {} : product.environment),
        ...(rovaraAi === undefined ? {} : rovaraAi.environment),
        ...(bedrockByo === undefined ? {} : bedrockByo.environment),
        ...(props.aiSourceKinds === undefined ? {} : { [MODEL_GATEWAY_ENV.aiSourceKinds]: props.aiSourceKinds }),
        ...(props.offeredPrices === true ? { [MODEL_GATEWAY_ENV.offeredPrices]: "on" } : {}),
      },
    });
    props.repository.grantPull(serveTask.obtainExecutionRole());

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: serveTask,
      desiredCount: MODEL_GATEWAY_MIN_TASKS,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [taskGroup],
      enableExecuteCommand: false,
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.ENABLED,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc,
      internetFacing: true,
      securityGroup: albGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      idleTimeout: Duration.seconds(MODEL_GATEWAY_CALL_CEILING_SECONDS),
      dropInvalidHeaderFields: true,
    });
    const listener = alb.addListener("Https", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      certificates: [elbv2.ListenerCertificate.fromArn(certificateArn.valueAsString)],
      open: false,
    });
    const targetGroup = listener.addTargets("Tasks", {
      port: MODEL_GATEWAY_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      // A release drains a task for as long as one call may last, so no open stream is cut.
      deregistrationDelay: Duration.seconds(MODEL_GATEWAY_CALL_CEILING_SECONDS),
      healthCheck: { path: "/healthz", healthyHttpCodes: "200", interval: Duration.seconds(15), healthyThresholdCount: 2, unhealthyThresholdCount: 3 },
    });

    // The daily price fetch: the same image in price-fetch mode (packages/model-gateway/src/process.ts runPriceFetch), its own role.
    const fetchLogs = new logs.LogGroup(this, "PriceFetchLogs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });
    const fetchTask = new ecs.FargateTaskDefinition(this, "PriceFetchTask", {
      cpu: 512,
      memoryLimitMiB: 2048,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      taskRole: fetchRole,
      executionRole: executionRole("PriceFetchExecutionRole", "price-fetch"),
    });
    fetchTask.addContainer("price-fetch", {
      image,
      essential: true,
      readonlyRootFilesystem: true,
      user: "1000:1000",
      logging: ecs.LogDrivers.awsLogs({ logGroup: fetchLogs, streamPrefix: "price-fetch" }),
      environment: { ...shared, [MODEL_GATEWAY_ENV.mode]: "price-fetch" },
    });
    props.repository.grantPull(fetchTask.obtainExecutionRole());
    new events.Rule(this, "PriceFetchSchedule", {
      description: `Rovara Cloud ${env}: the model gateway's daily price fetch`,
      schedule: events.Schedule.expression(MODEL_GATEWAY_PRICE_FETCH_SCHEDULE),
      enabled: true,
      targets: [new targets.EcsTask({
        cluster,
        taskDefinition: fetchTask as ecs.ITaskDefinition,
        taskCount: 1,
        launchType: ecs.LaunchType.FARGATE,
        subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
        securityGroups: [fetchGroup],
      })],
    });

    // Alarms, to one topic (subscribe by hand). Gateway events are counted from its JSON log lines.
    const topic = new sns.Topic(this, "Alarms", { displayName: `Rovara Cloud ${env} model gateway alarms`, enforceSSL: true });
    // CloudWatch needs its own allow to publish here: enforceSSL adds only a Deny, and without an allow every alarm action
    // failed with "Failed to execute action" (staging, 2026-11-17). Scoped to this account and to this stack's alarms, whose
    // names are fixed below (stack name, then the alarm id) so the ARN pattern is exact.
    const alarmNamePrefix = `${this.stackName}-`;
    topic.addToResourcePolicy(new iam.PolicyStatement({
      sid: "AllowCloudWatchAlarms",
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal("cloudwatch.amazonaws.com")],
      actions: ["sns:Publish"],
      resources: [topic.topicArn],
      conditions: {
        StringEquals: { "aws:SourceAccount": this.account },
        ArnLike: { "aws:SourceArn": `arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:${alarmNamePrefix}*` },
      },
    }));
    const notify = new cwActions.SnsAction(topic);
    const fiveMinutes = Duration.minutes(5);
    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, description: string, evaluationPeriods = 1, comparison = cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD) => {
      new cloudwatch.Alarm(this, id, {
        alarmName: `${alarmNamePrefix}${id}`, metric, threshold, evaluationPeriods, comparisonOperator: comparison, alarmDescription: description,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notify);
    };
    const fromLog = (id: string, group: logs.ILogGroup, event: string, period: Duration) => new logs.MetricFilter(this, `${id}Filter`, {
      logGroup: group,
      filterPattern: id === "SettleFailures"
        ? logs.FilterPattern.any(logs.FilterPattern.stringValue("$.event", "=", event), logs.FilterPattern.stringValue("$.event", "=", "customer_source_over_reservation"))
        : logs.FilterPattern.stringValue("$.event", "=", event),
      metricNamespace: MODEL_GATEWAY_METRICS_NAMESPACE,
      metricName: `${id}-${env}`,
      metricValue: "1",
      defaultValue: 0,
    }).metric({ statistic: "Sum", period });
    alarm("Target5xx", targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: fiveMinutes, statistic: "Sum" }), MODEL_GATEWAY_ALARMS.target5xx, "The gateway answered 5xx (provider errors, unavailable)");
    alarm("LoadBalancer5xx", alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: fiveMinutes, statistic: "Sum" }), MODEL_GATEWAY_ALARMS.loadBalancer5xx, "The load balancer answered 5xx itself (no healthy task, timeouts)");
    alarm("HealthyTasks", targetGroup.metrics.healthyHostCount({ period: Duration.minutes(1), statistic: "Minimum" }), MODEL_GATEWAY_MIN_TASKS, "Fewer than two gateway tasks are healthy", 3, cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD);
    alarm("Refusals", fromLog("Refusals", serveLogs, MODEL_GATEWAY_LOG_EVENTS.refused, fiveMinutes), MODEL_GATEWAY_ALARMS.refusals, "Many calls refused (tokens, budgets, guard)");
    alarm("BusyAnswers", fromLog("BusyAnswers", serveLogs, MODEL_GATEWAY_LOG_EVENTS.overrunBusy, fiveMinutes), MODEL_GATEWAY_ALARMS.busy, "Many busy answers: calls waiting on another estimated-price call of the same company");
    if (openRouterEnabled) alarm("OpenRouterOverReservation", fromLog("OpenRouterOverReservation", serveLogs, MODEL_GATEWAY_LOG_EVENTS.openRouterOverReservation, fiveMinutes), 1, "OpenRouter settled above its hold; review the source before allowing more calls");
    alarm("SettleFailures", fromLog("SettleFailures", serveLogs, MODEL_GATEWAY_LOG_EVENTS.settleFailed, fiveMinutes), MODEL_GATEWAY_ALARMS.settleFailed, "A call could not settle, or customer-paid provider usage exceeded its hold (admission stopped)");
    alarm("PriceFetchFailures", fromLog("PriceFetchFailures", fetchLogs, MODEL_GATEWAY_LOG_EVENTS.priceFetchFailed, Duration.hours(1)), MODEL_GATEWAY_ALARMS.priceFetchFailed, "The daily price fetch failed (the last good prices stay)");
    // Staleness: no saved fetch on any of the last three days. A new stack has no fetch log yet, and missing data counted as
    // breaching made this alarm fire about 30 minutes after every create. So missing data does not breach; the alarm counts a
    // day only when the gateway itself reported that day (healthy-host samples exist from the day the stack is made) and no
    // fetch was saved. Silence from the fetch (rule off, task never starting) still counts as stale, after about two to three days (the oldest day counts once the gateway has reported in it).
    const oneDay = Duration.days(1);
    new cloudwatch.Alarm(this, "PricesStale", {
      alarmName: `${alarmNamePrefix}PricesStale`,
      metric: new cloudwatch.MathExpression({
        expression: "IF(alive > 0, 1, 0) * IF(FILL(fetched, 0) < 1, 1, 0)",
        usingMetrics: {
          alive: targetGroup.metrics.healthyHostCount({ period: oneDay, statistic: "SampleCount" }),
          fetched: fromLog("PricesFetched", fetchLogs, MODEL_GATEWAY_LOG_EVENTS.priceFetched, oneDay),
        },
        period: oneDay,
        label: "Days without a saved price fetch",
      }),
      threshold: 1, evaluationPeriods: MODEL_GATEWAY_ALARMS.priceStaleDays, datapointsToAlarm: MODEL_GATEWAY_ALARMS.priceStaleDays,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "No price fetch has saved prices for three days: estimates use stale prices",
    }).addAlarmAction(notify);

    new CfnOutput(this, "GatewayAddress", { value: `https://${alb.loadBalancerDnsName}`, description: "Point the certificate's name at this (DNS is outside this stack); Code's model-access route answers that name" });
    new CfnOutput(this, "Issuer", { value: issuer, description: "The one Code install trusted" });
    new CfnOutput(this, "ProviderKeySecrets", {
      value: Fn.join(",", secrets.map((secret) => secret.secretId)),
      description: fixedSecretNames
        ? "Put each provider's key here (write only; only the gateway reads)"
        : "Put each provider's key here, by secret ARN, in the order of the providers (anthropic first): aws secretsmanager put-secret-value --secret-id <ARN> (write only; only the gateway reads)",
    });
    new CfnOutput(this, "AlarmTopic", { value: topic.topicArn });
    if (product !== undefined) {
      new CfnOutput(this, "ProductKeysTableName", { value: product.keysTable.tableName, description: "Cloud's settings routes write product keys, eval approvals and budgets here (RovaraCloudWeb parameter ProductKeysTableName)" });
      new CfnOutput(this, "ProductKeysKeyArn", { value: product.key.keyArn, description: "Seals product keys (RovaraCloudWeb parameter ProductKeysKeyArn): Cloud's settings role may only GenerateDataKey, only this gateway's role Decrypt" });
      new CfnOutput(this, "ProductKeysMacKeyArn", { value: product.macKey.keyArn, description: "Keyed fingerprints of product keys and change intents (RovaraCloudWeb parameter ProductKeysMacKeyArn)" });
      new CfnOutput(this, "VertexFederationRoleArn", { value: product.vertexRole.roleArn, description: "Customers name this role in their Google workload identity pool (attribute condition on the assumed-role ARN with their company id)" });
    }
    if (bedrockByo !== undefined) new CfnOutput(this, "BedrockBrokerRoleArn", { value: bedrockByo.broker.roleArn, description: "Customers' RovaraBedrockInvoke roles trust this role (with their external id): never delete or rename it" });
    // The release pipeline's own outputs, only when it names the commit (model-gateway-deployed-sha.ts): the deployed sha and the service its settled gate reads.
    if (addDeployedCodeSha(this)) new CfnOutput(this, GATEWAY_SERVICE_ARN_OUTPUT, { value: service.serviceArn, description: "The gateway's Fargate service (read by the release pipeline's settled gate)" });
    // Last, so the template keeps its section order; the aspect puts it on every role at synth (model-gateway-boundary.ts).
    applyCloudBoundary(this, env, "gateway");
  }

  /**
   * Bring your own Bedrock (DEC 238). Two pieces, both RETAINED and never replaced, because every customer's role names them:
   *   - the Bedrock broker role, at a FIXED name. If it were deleted and made again, IAM would have rewritten each customer's trust
   *     policy principal to the old role's unique id, and every connection would break silently. Only the serving role may
   *     assume it (with an org_* session name); its only right is sts:AssumeRole on customers' RovaraBedrockInvoke-* roles, with
   *     an external id of Rovara's form and an org_* session name. It has no Bedrock rights of its own.
   *   - the external-id HMAC key: each company's external id is an HMAC under it, so replacing it would change every id. Only the
   *     serving role may GenerateMac with it (Cloud asks the gateway: service-call.ts BEDROCK_SETUP_PATH).
   */
  private bedrockByo(env: string, serveRole: iam.Role) {
    const broker = new iam.Role(this, "BedrockBrokerRole", {
      roleName: bedrockBrokerRoleName(env),
      assumedBy: new iam.ArnPrincipal(serveRole.roleArn).withConditions({ StringLike: { "sts:RoleSessionName": "org_*" } }),
      description: `Rovara Cloud ${env}: assumes customers' invoke-only Bedrock roles with their external id (no Bedrock rights of its own)`,
      maxSessionDuration: Duration.hours(1),
      inlinePolicies: {
        AssumeCustomerBedrockRoles: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: "AssumeCustomerBedrockRoles", actions: ["sts:AssumeRole"],
            resources: [`arn:${this.partition}:iam::*:role/${BEDROCK_BYO_CUSTOMER_ROLE_PREFIX}*`],
            // Customers' accounts only: never a role of that name in Rovara's own account (made by mistake or by an insider).
            conditions: byoCustomerAssumeConditions(this.account),
          })],
        }),
      },
    });
    broker.applyRemovalPolicy(RemovalPolicy.RETAIN);
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "AssumeBedrockBroker", actions: ["sts:AssumeRole"], resources: [broker.roleArn], conditions: { StringLike: { "sts:RoleSessionName": "org_*" } } }));
    // A fixed alias: if this construct were ever moved or renamed, the new key's alias would clash with the old one's and the
    // deploy would FAIL, instead of silently changing every company's external id. A property change that replaces the key
    // would only re-point the alias: never change this key's properties (the contract test pins its logical id, spec and usage).
    const externalIdKey = new kms.Key(this, "BedrockExternalIdKey", {
      alias: bedrockExternalIdKeyAlias(env),
      description: `Rovara Cloud ${env}: makes each company's Bedrock external id (HMAC). Never delete or replace: customers' roles name its ids`,
      keySpec: kms.KeySpec.HMAC_256,
      keyUsage: kms.KeyUsage.GENERATE_VERIFY_MAC,
      removalPolicy: RemovalPolicy.RETAIN,
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: "AccountManagesNotUses", principals: [new iam.AccountRootPrincipal()],
            actions: ["kms:CreateAlias", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:TagResource", "kms:UntagResource"],
            resources: ["*"],
          }),
          new iam.PolicyStatement({ sid: "OnlyGatewayMakesExternalIds", principals: [new iam.AccountRootPrincipal()], actions: ["kms:GenerateMac"], resources: ["*"], conditions: { ArnEquals: { "aws:PrincipalArn": serveRole.roleArn } } }),
        ],
      }),
    });
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "MakeBedrockExternalIds", actions: ["kms:GenerateMac"], resources: [externalIdKey.keyArn] }));
    return {
      broker, externalIdKey,
      environment: { [MODEL_GATEWAY_ENV.bedrockBrokerRole]: broker.roleArn, [MODEL_GATEWAY_ENV.bedrockExternalIdKey]: externalIdKey.keyArn },
    };
  }

  /**
   * Rovara's AI for agents (DEC 240): Bedrock in THIS account, on the serving role. Exactly two actions (Converse is not used),
   * on the allow-listed system inference profiles in this Region and, only through those profiles, their foundation models in
   * the profile's Regions (DEC 243: `us.` profiles only). No other Bedrock action, model or Region; no
   * Marketplace rights (model access is enabled once by an operator). Production is refused before this (the constructor).
   */
  private rovaraAi(settings: RovaraAiProps, productOn: boolean, serveRole: iam.Role) {    if (!productOn) throw new Error(`${MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY} needs ${MODEL_GATEWAY_PRODUCT_CONTEXT_KEY}=on (the company picks its agents' AI in company-key mode)`);
    const region = this.region;
    const models = settings.models === "on" ? `${ROVARA_AI_US_MODELS},${ROVARA_AI_US_CONVERSE_MODELS}` : settings.models;
    const ids = rovaraAiModelIds(models, region);
    const exempt = settings.exempt ?? "";
    const exemptIds = exempt === "" ? [] : exempt.split(",");
    if (exemptIds.length > 10 || exemptIds.some((id) => !ROVARA_AI_COMPANY.test(id)) || new Set(exemptIds).size !== exemptIds.length) throw new Error(`${MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY}: give company ids (org_...), comma-separated`);
    const actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"];
    const profiles = ids.filter((m): m is { id: string; geography: string; model: string } => m.geography !== undefined);
    const inRegion = ids.filter((m) => m.geography === undefined);
    const profileArn = (id: string) => `arn:${this.partition}:bedrock:${region}:${this.account}:inference-profile/${id}`;
    const modelArn = (where: string, model: string) => `arn:${this.partition}:bedrock:${where}::foundation-model/${model}`;
    if (profiles.length > 0) {
      serveRole.addToPolicy(new iam.PolicyStatement({ sid: "RovaraAiProfiles", actions, resources: [...new Set(profiles.map((m) => profileArn(m.id)))] }));
      serveRole.addToPolicy(new iam.PolicyStatement({
        sid: "RovaraAiProfileModels", actions,
        resources: [...new Set(profiles.flatMap((m) => ROVARA_AI_PROFILE_REGIONS[m.geography]!.map((where) => modelArn(where, m.model))))],
        conditions: { StringEquals: { "bedrock:InferenceProfileArn": [...new Set(profiles.map((m) => profileArn(m.id)))] } },
      }));
    }
    // DEC 243c: a non-Claude model with no profile, in this Region only (Converse is authorised by these same two actions).
    if (inRegion.length > 0) serveRole.addToPolicy(new iam.PolicyStatement({ sid: "RovaraAiModels", actions, resources: [...new Set(inRegion.map((m) => modelArn(region, m.model)))] }));
    const disabled = settings.disabled;
    if (disabled !== undefined && disabled !== "" && (disabled.split(",").length > 64 || new Set(disabled.split(",").map((name) => name.trim())).size !== disabled.split(",").length || disabled.split(",").some((name) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(name.trim())))) throw new Error(`${MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY}: give model names, comma-separated`);
    return { environment: { [MODEL_GATEWAY_ENV.rovaraAiSourceId]: `${serveRole.roleArn}@${this.region}`, [MODEL_GATEWAY_ENV.rovaraAiModels]: models, ...(exempt === "" ? {} : { [MODEL_GATEWAY_ENV.rovaraAiExempt]: exempt }), ...(disabled === undefined ? {} : { [MODEL_GATEWAY_ENV.agentModelsDisabled]: disabled }) } };
  }

  /**
   * The product-AI route's resources (B5, B6, B8, #57, #58), made only when asked. Every table keeps the gateway's defaults
   * (on-demand, point-in-time recovery, deletion protection, retained) and company keys; every grant names exact tables, indexes
   * and keys, pinned statement by statement in tests/contract/model-gateway-product-infra.test.ts.
   */
  private productAi(env: string, issuer: string, serveRole: iam.Role, moneyActions: string[], companyKeysOnly: Record<string, unknown>) {
    const settingsRoleArn = new CfnParameter(this, "CloudSettingsRoleArn", {
      type: "String",
      allowedPattern: "^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}$",
      constraintDescription: "an IAM role ARN, without wildcards",
      description: "The Rovara Cloud server's role (RovaraCloudWeb output ServerRoleArn): it seals product keys (GenerateDataKey and GenerateMac only, never Decrypt)",
    });
    const sparse = (indexes: Record<string, { name: string; partitionKey: string; sortKey: string }>) => Object.values(indexes).map((index) => ({
      indexName: index.name,
      partitionKey: { name: index.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: index.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    }));
    // The product key store: keys (sealed), eval approvals and budgets, receipts and audit rows. Key rows purge by TTL.
    const keysTable = table(this, "ProductKeys", true);
    // The product meter and the learning meter: each its own three tables (combined with the agent meter's company row in code).
    const productMeter = table(this, "ProductMeter", false, sparse(MODEL_GATEWAY_METER_INDEXES));
    const productLedger = table(this, "ProductLedger", false, sparse(MODEL_GATEWAY_LEDGER_INDEXES));
    const productMarkers = table(this, "ProductMarkers", true);
    const learningMeter = table(this, "LearningMeter", false, sparse(MODEL_GATEWAY_METER_INDEXES));
    const learningLedger = table(this, "LearningLedger", false, sparse(MODEL_GATEWAY_LEDGER_INDEXES));
    const learningMarkers = table(this, "LearningMarkers", true);
    // The answers meter (L4-E, hosted Ask and smart Just answer): its own three tables as well, combined with the agent meter's company row in code.
    const answersMeter = table(this, "AnswersMeter", false, sparse(MODEL_GATEWAY_METER_INDEXES));
    const answersLedger = table(this, "AnswersLedger", false, sparse(MODEL_GATEWAY_LEDGER_INDEXES));
    const answersMarkers = table(this, "AnswersMarkers", true);
    // Eval stages shared by every serving task (B8): conditional writes, rows expire after the stage plus the call ceiling.
    const stages = table(this, "EvalStages", true, sparse(MODEL_GATEWAY_EVAL_STAGE_INDEXES));

    const manage = new iam.PolicyStatement({
      sid: "AccountManagesNotUses",
      principals: [new iam.AccountRootPrincipal()],
      actions: [
        "kms:CreateAlias", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*",
        "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:RotateKeyOnDemand",
      ],
      resources: ["*"],
    });
    // Bound to one install (this gateway's issuer), the product purpose, and exactly the six context keys a sealed row carries.
    const sealedRow = {
      StringEquals: { "kms:EncryptionContext:purpose": PRODUCT_KEY_PURPOSE, "kms:EncryptionContext:install": issuer },
      "ForAllValues:StringEquals": { "kms:EncryptionContextKeys": [...PRODUCT_KEY_CONTEXT_KEYS] },
      Null: { "kms:EncryptionContext:company": "false", "kms:EncryptionContext:owner": "false", "kms:EncryptionContext:source": "false", "kms:EncryptionContext:version": "false" },
    };
    const key = new kms.Key(this, "ProductKeysKey", {
      description: `Rovara Cloud ${env}: seals customers' product AI keys; Cloud's settings role seals, only the gateway's serving role opens`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      policy: new iam.PolicyDocument({
        statements: [
          manage,
          // By the role's ARN as a condition (as the provider-keys key): a replaced role keeps access, no wait on a new one.
          new iam.PolicyStatement({ sid: "OnlyGatewayOpens", principals: [new iam.AccountRootPrincipal()], actions: ["kms:Decrypt"], resources: ["*"], conditions: { ...sealedRow, ArnEquals: { "aws:PrincipalArn": serveRole.roleArn } } }),
          new iam.PolicyStatement({ sid: "OnlySettingsSeals", principals: [new iam.AccountRootPrincipal()], actions: ["kms:GenerateDataKey"], resources: ["*"], conditions: { ...sealedRow, ArnEquals: { "aws:PrincipalArn": settingsRoleArn.valueAsString } } }),
        ],
      }),
    });
    // Keyed fingerprints (F1-d L4) and Cloud's signed calls to this gateway (the Vertex connection test, service-call.ts, its own
    // purpose in every message): an HMAC key that never leaves KMS. Only the settings role makes MACs; only the serving role verifies.
    const macKey = new kms.Key(this, "ProductKeysMacKey", {
      description: `Rovara Cloud ${env}: keyed fingerprints of product AI keys and change intents, and Cloud's signed calls to the gateway`,
      keySpec: kms.KeySpec.HMAC_256,
      keyUsage: kms.KeyUsage.GENERATE_VERIFY_MAC,
      removalPolicy: RemovalPolicy.RETAIN,
      policy: new iam.PolicyDocument({
        statements: [
          manage,
          new iam.PolicyStatement({ sid: "OnlySettingsFingerprints", principals: [new iam.AccountRootPrincipal()], actions: ["kms:GenerateMac"], resources: ["*"], conditions: { ArnEquals: { "aws:PrincipalArn": settingsRoleArn.valueAsString } } }),
          new iam.PolicyStatement({ sid: "OnlyGatewayVerifiesCalls", principals: [new iam.AccountRootPrincipal()], actions: ["kms:VerifyMac"], resources: ["*"], conditions: { ArnEquals: { "aws:PrincipalArn": serveRole.roleArn } } }),
        ],
      }),
    });

    // The serving role: read keys (and record a refused-key warning on the document), the two product meters as the agent's,
    // the stage table's items and its one index, Decrypt of a sealed row of this install.
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "ProductKeysCompanyKeys", actions: ["dynamodb:GetItem", "dynamodb:PutItem"], resources: [keysTable.tableArn], conditions: companyKeysOnly }));
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "ProductAndLearningMeterCompanyKeys", actions: moneyActions, resources: [productMeter.tableArn, productLedger.tableArn, learningMeter.tableArn, learningLedger.tableArn, answersMeter.tableArn, answersLedger.tableArn], conditions: companyKeysOnly }));
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "ProductAndLearningMarkersCompanyKeys", actions: [...moneyActions, "dynamodb:DeleteItem"], resources: [productMarkers.tableArn, learningMarkers.tableArn, answersMarkers.tableArn], conditions: companyKeysOnly }));
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "EvalStagesCompanyKeys", actions: ["dynamodb:GetItem", "dynamodb:PutItem"], resources: [stages.tableArn], conditions: companyKeysOnly }));
    serveRole.addToPolicy(new iam.PolicyStatement({
      sid: "QueryProductIndexes", actions: ["dynamodb:Query"],
      resources: [
        ...[productLedger, learningLedger, answersLedger].flatMap((ledger) => Object.values(MODEL_GATEWAY_LEDGER_INDEXES).map((index) => `${ledger.tableArn}/index/${index.name}`)),
        ...[productMeter, learningMeter, answersMeter].flatMap((meter) => Object.values(MODEL_GATEWAY_METER_INDEXES).map((index) => `${meter.tableArn}/index/${index.name}`)),
        ...Object.values(MODEL_GATEWAY_EVAL_STAGE_INDEXES).map((index) => `${stages.tableArn}/index/${index.name}`),
      ],
    }));
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "VerifyCloudCalls", actions: ["kms:VerifyMac"], resources: [macKey.keyArn] }));
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "OpenProductKeys", actions: ["kms:Decrypt"], resources: [key.keyArn], conditions: { StringEquals: { "kms:EncryptionContext:purpose": PRODUCT_KEY_PURPOSE, "kms:EncryptionContext:install": issuer } } }));

    // Vertex federation (#58, DEC 229b): a role with NO permissions. Only this gateway's serving role may assume it, and only with
    // a company id as the session name; the customer's Google pool trusts the assumed-role ARN carrying their own company id.
    const vertexRole = new iam.Role(this, "VertexFederationRole", {
      assumedBy: new iam.ArnPrincipal(serveRole.roleArn).withConditions({ StringLike: { "sts:RoleSessionName": "org_*" } }),
      description: `Rovara Cloud ${env}: the model gateway's identity at Google for Vertex AI (no AWS permissions)`,
      maxSessionDuration: Duration.hours(1),
    });
    serveRole.addToPolicy(new iam.PolicyStatement({ sid: "AssumeVertexFederation", actions: ["sts:AssumeRole"], resources: [vertexRole.roleArn], conditions: { StringLike: { "sts:RoleSessionName": "org_*" } } }));

    return {
      keysTable, key, macKey, vertexRole,
      environment: {
        [MODEL_GATEWAY_ENV.productKeysTable]: keysTable.tableName,
        [MODEL_GATEWAY_ENV.productKeysKey]: key.keyArn,
        [MODEL_GATEWAY_ENV.productMeterTable]: productMeter.tableName,
        [MODEL_GATEWAY_ENV.productLedgerTable]: productLedger.tableName,
        [MODEL_GATEWAY_ENV.productMarkersTable]: productMarkers.tableName,
        [MODEL_GATEWAY_ENV.evalStagesTable]: stages.tableName,
        [MODEL_GATEWAY_ENV.vertexFederationRole]: vertexRole.roleArn,
        [MODEL_GATEWAY_ENV.productMacKey]: macKey.keyArn,
        [MODEL_GATEWAY_ENV.learningMeterTable]: learningMeter.tableName,
        [MODEL_GATEWAY_ENV.learningLedgerTable]: learningLedger.tableName,
        [MODEL_GATEWAY_ENV.learningMarkersTable]: learningMarkers.tableName,
        [MODEL_GATEWAY_ENV.answersMeterTable]: answersMeter.tableName,
        [MODEL_GATEWAY_ENV.answersLedgerTable]: answersLedger.tableName,
        [MODEL_GATEWAY_ENV.answersMarkersTable]: answersMarkers.tableName,
        // DEC 236: with the company key store deployed, agents call AI only on each company's own connected key.
        [MODEL_GATEWAY_ENV.agentKeys]: "company",
      },
    };
  }
}
