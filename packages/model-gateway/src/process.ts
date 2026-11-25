import { createRateQuoteHandler, RATE_QUOTE_PATH, RATE_QUOTE_TOKEN_KIND } from "./rate-quote.js";
import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { credentialsFromEnvironment, type CredentialSource } from "./aws.js";
import type { CapsSource } from "./caps.js";
import { CompanyAnswersLimits, CompanyBudgetCaps, CompanyLessonsSwitch, CompanyUpkeepLimits } from "./company-caps.js";
import type { UpkeepLimits } from "./upkeep-cap.js";
import { createLearningRoutes, type LearningKeySource, type LearningRouteOptions } from "./learning-route.js";
import { createAnswersRoutes, type AnswersLimits } from "./answers-route.js";
import { createOpenAiTransport } from "./learning-openai.js";
import { createChatCompletionsTransport } from "./agent-openai.js";
import { endpointTarget, type EndpointTarget } from "./endpoint-guard.js";
import { createEndpointTransport, parseEndpointConnect } from "./endpoint-source.js";
import { createGeminiTransport } from "./product-gemini.js";
import { createVertexTransport } from "./product-vertex.js";
import { runCorrections, runExpirySweep } from "./correction.js";
import { awsKms } from "./aws-kms.js";
import { CompanyAgentAiSource, parseAiSourceKinds, parseRovaraAiExempt, parseRovaraAiModels, storedBedrock, type AgentAiSource, type AgentAiSourceReader, type ByoBedrock, type RovaraAi } from "./agent-ai.js";
import { InstallRovaraAi } from "./rovara-ai-stop.js";
import { BedrockExternalIds, type MacGenerator } from "./bedrock-byo.js";
import { BedrockSessions } from "./bedrock-byo-sessions.js";
import { createBedrockTransport } from "./bedrock-transport.js";
import { createBedrockProductTransport } from "./product-bedrock.js";
import { GATEWAY_AGENT_KEY_MODES, GATEWAY_ANSWERS_ENV, GATEWAY_ENV, GATEWAY_LEARNING_ENV, GATEWAY_LOG_EVENTS, GATEWAY_MODES, GATEWAY_PRODUCT_ENV, type GatewayAgentKeyMode } from "./deploy.js";
import { DynamoEvalStageStore } from "./dynamo-eval-stages.js";
import { DynamoProductKeyTable } from "./dynamo-product-keys.js";
import { DynamoProductOverrunTasks } from "./dynamo-product-overrun.js";
import { storedEvalApprovals, storedEvalBudget } from "./eval-approvals.js";
import { storedLearningKeys } from "./learning-keys.js";
import { createTokenHttp, VertexTokens, type TokenHttp } from "./product-vertex-token.js";
import { ProductKeyStore } from "./product-keys.js";
import { createProductRoutes, productModelLimitsFrom } from "./product-route.js";
import { kmsProductKeyService, ProductKeySealer, type KmsLike, type ProductKeyFingerprinter } from "./product-seal.js";
import { createSignedTokenVerifier } from "./token.js";
import { createEvalAuthorityHandler, EVAL_AUTHORITY_PATH, EVAL_AUTHORITY_TOKEN_KIND } from "./eval-authority.js";
import { createEvalCapHandler, EVAL_CAP_PATH, EVAL_CAP_TOKEN_KIND } from "./eval-cap.js";
import { createTaskEndedHandler, TASK_ENDED_PATH, TASK_ENDED_TOKEN_KIND } from "./task-ended-notice.js";
import { COMPANY_INSTRUCTIONS_PATH, COMPANY_INSTRUCTIONS_TOKEN_KIND, CompanyStoredInstructions, createCompanyInstructionsHandler, type CompanyInstructionsSource } from "./company-instructions.js";
import { createOfferedModelsHandler, offeredModelPrice, OFFERED_MODELS_PATH, parseDisabledAgentModels, SERVICE_TOKEN_KIND } from "./offered-models.js";
import { createUpkeepCapReadHandler, UPKEEP_CAP_READ_PATH, UPKEEP_CAP_READ_TOKEN_KIND } from "./upkeep-cap-read.js";
import { createRunChargesHandler, RUN_CHARGES_PATH, RUN_CHARGES_TOKEN_KIND } from "./run-charges-read.js";
import { BEDROCK_CHECK_PATH, BEDROCK_SETUP_PATH, createBedrockServiceHandlers, createVertexCheckHandler, VERTEX_CHECK_PATH, type MacVerifier } from "./service-call.js";
import { Dynamo } from "./dynamo.js";
import { DynamoEndedTasks, DynamoMeter } from "./dynamo-meter.js";
import { DynamoPriceSnapshotStore } from "./dynamo-prices.js";
import type { ModelLimitsSource } from "./guard.js";
import type { Meter } from "./meter.js";
import { ProductEvalStages } from "./product-eval.js";
import { createJwksReader, StaticInstallRegistry } from "./installs.js";
import { SnapshotPriceSource } from "./price-index.js";
import { PriceRefresher } from "./price-refresh.js";
import { fetchAWS, fetchLiteLLM, fetchTransport } from "./price-sources.js";
import { CALL_HARD_CEILING_MS, createAnthropicTransport, type ProviderKeys, type ProviderTransport } from "./provider.js";
import { companyRoomMicros, DynamoReviewerGrants } from "./reviewer-grants.js";
import { createSecretsManagerKeys, ProviderKeyUnavailable } from "./secrets.js";
import { createGatewayHandler, type GatewayDependencies, type ProductRouteResolver } from "./server.js";
import { createTaskTokenVerifier } from "./token.js";

/**
 * The gateway process (the image's entry, main.ts): GATEWAY_MODE=serve runs the HTTP service behind the load balancer,
 * GATEWAY_MODE=price-fetch runs the daily price fetch once and exits. Settings come from deploy.ts's environment names; a
 * provider key comes from Secrets Manager by ARN, never from the environment.
 */

export type GatewayEnv = Readonly<Record<string, string | undefined>>;
export interface InstallConfig { issuer: string; jwksUrl: string; taskKids: string[] }
/** The product route's deployed settings (deploy.ts GATEWAY_PRODUCT_ENV): all set, or the route is off. */
export interface ProductConfig { keysTable: string; keysKeyArn: string; meter: string; ledger: string; markers: string; stages: string; vertexFederationRoleArn?: string; /** Cloud's Vertex connection test (service-call.ts), only with the Vertex role. */ macKeyArn?: string }
/** The learning route's meter tables (GATEWAY_LEARNING_ENV): only with the product route, whose key store holds the company's account. */
export interface LearningConfig { meter: string; ledger: string; markers: string }
/** The answers route's meter tables (GATEWAY_ANSWERS_ENV): only with the product route, whose key store holds the company's account. */
export type AnswersConfig = LearningConfig;
export interface ServeConfig { mode: "serve"; region: string; port: number; install: InstallConfig; tables: { meter: string; ledger: string; markers: string; prices: string; companies: string }; anthropicKeySecret: string; product?: ProductConfig; learning?: LearningConfig; answers?: AnswersConfig; /** DEC 236. Absent: "install". */ agentKeys?: GatewayAgentKeyMode; /** DEC 240, only with agentKeys "company". Absent: Rovara's AI is off. */ rovaraAi?: RovaraAiConfig; /** DEC 238, only with agentKeys "company" and the product MAC key. Absent: a company's own Bedrock is refused. */ bedrockByo?: BedrockByoConfig; /** DEC 254t, only with agentKeys "company": the switched-on company AI source kinds. Absent: none. */ aiSourceKinds?: ReadonlySet<string>; /** Models left off every company's offered list on Rovara's AI (offered-models.ts). Absent: the default list. */ agentModelsDisabled?: ReadonlySet<string>; /** DEC 254zzz96 (2): publish list prices on the offered list. Absent: off. */ offeredPrices?: true }
/** Bring your own Bedrock (DEC 238): Rovara's broker role and the KMS HMAC key the companies' external ids come from. */
export interface BedrockByoConfig { brokerRoleArn: string; externalIdKeyArn: string }
/** Rovara's AI (DEC 240): the allow-list (agent model to Bedrock id, the gateway's own region's geography) and the exempt companies. */
export interface RovaraAiConfig { sourceId?: string; models: ReadonlyMap<string, string>; exempt: ReadonlySet<string> }
export interface PriceFetchConfig { mode: "price-fetch"; region: string; tables: { prices: string } }
export type GatewayConfig = ServeConfig | PriceFetchConfig;

/** A setting is missing or malformed. The message names the variable (a name, never a value). */
export class GatewayConfigError extends Error {
  constructor(readonly variable: string) { super(`gateway setting missing or invalid: ${variable}`); this.name = "GatewayConfigError"; }
}

const TABLE = /^[A-Za-z0-9_.-]{3,255}$/u;
const KID = /^[A-Za-z0-9_-]{16}$/u;
export const JWKS_PATH = "/.well-known/jwks.json";

export function readGatewayConfig(env: GatewayEnv): GatewayConfig {
  const need = (name: string, valid: (value: string) => boolean): string => {
    const value = env[name];
    if (value === undefined || value.length > 2048 || !valid(value)) throw new GatewayConfigError(name);
    return value;
  };
  const mode = need(GATEWAY_ENV.mode, (value) => (GATEWAY_MODES as readonly string[]).includes(value)) as GatewayConfig["mode"];
  const regionName = env.AWS_REGION !== undefined ? "AWS_REGION" : "AWS_DEFAULT_REGION";
  const region = need(regionName, (value) => /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(value));
  const prices = need(GATEWAY_ENV.pricesTable, (value) => TABLE.test(value));
  if (mode === "price-fetch") return { mode, region, tables: { prices } };
  const port = Number(need(GATEWAY_ENV.port, (value) => /^\d{1,5}$/u.test(value) && Number(value) >= 1 && Number(value) <= 65535));
  const issuer = need(GATEWAY_ENV.installIssuer, (value) => { try { const url = new URL(value); return url.protocol === "https:" && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && url.href === value && !value.endsWith("/"); } catch { return false; } });
  // Pinned beside the issuer (TC-1: <iss>/.well-known/jwks.json), never another host.
  const jwksUrl = need(GATEWAY_ENV.installJwksUrl, (value) => value === `${issuer}${JWKS_PATH}`);
  const taskKids = need(GATEWAY_ENV.installTaskKids, (value) => { const kids = value.split(","); return kids.length >= 1 && kids.length <= 2 && kids.every((kid) => KID.test(kid)) && new Set(kids).size === kids.length; }).split(",");
  const table = (name: string) => need(name, (value) => TABLE.test(value));
  const anthropicKeySecret = need(GATEWAY_ENV.anthropicKeySecret, (value) => /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/u.test(value));
  const tables = { meter: table(GATEWAY_ENV.meterTable), ledger: table(GATEWAY_ENV.ledgerTable), markers: table(GATEWAY_ENV.markersTable), prices, companies: table(GATEWAY_ENV.companyTable) };
  // Off unless configured: the product settings all set or none (a partial set is a broken deploy, refused by name).
  const productSet = GATEWAY_PRODUCT_ENV.filter((name) => env[name] !== undefined);
  let product: ProductConfig | undefined;
  if (productSet.length > 0) {
    const missing = GATEWAY_PRODUCT_ENV.find((name) => env[name] === undefined);
    if (missing !== undefined) throw new GatewayConfigError(missing);
    product = {
      keysTable: table(GATEWAY_ENV.productKeysTable),
      keysKeyArn: need(GATEWAY_ENV.productKeysKey, (value) => /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/u.test(value)),
      meter: table(GATEWAY_ENV.productMeterTable), ledger: table(GATEWAY_ENV.productLedgerTable), markers: table(GATEWAY_ENV.productMarkersTable), stages: table(GATEWAY_ENV.evalStagesTable),
      ...(env[GATEWAY_ENV.vertexFederationRole] === undefined ? {} : { vertexFederationRoleArn: need(GATEWAY_ENV.vertexFederationRole, (value) => /^arn:aws[a-z-]*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,128}$/u.test(value)) }),
      ...(env[GATEWAY_ENV.productMacKey] === undefined ? {} : { macKeyArn: need(GATEWAY_ENV.productMacKey, (value) => env[GATEWAY_ENV.vertexFederationRole] !== undefined && /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/u.test(value)) }),
    };
  } else if (env[GATEWAY_ENV.vertexFederationRole] !== undefined || env[GATEWAY_ENV.productMacKey] !== undefined) {
    // Vertex is part of the product route: never on its own.
    throw new GatewayConfigError(GATEWAY_ENV.productKeysTable);
  }
  const learningSet = GATEWAY_LEARNING_ENV.filter((name) => env[name] !== undefined);
  let learning: LearningConfig | undefined;
  if (learningSet.length > 0) {
    const missing = GATEWAY_LEARNING_ENV.find((name) => env[name] === undefined);
    if (missing !== undefined) throw new GatewayConfigError(missing);
    // The company's learning account lives in the product key store: no learning route without it.
    if (product === undefined) throw new GatewayConfigError(GATEWAY_ENV.productKeysTable);
    learning = { meter: table(GATEWAY_ENV.learningMeterTable), ledger: table(GATEWAY_ENV.learningLedgerTable), markers: table(GATEWAY_ENV.learningMarkersTable) };
  }
  const answersSet = GATEWAY_ANSWERS_ENV.filter((name) => env[name] !== undefined);
  let answers: AnswersConfig | undefined;
  if (answersSet.length > 0) {
    const missing = GATEWAY_ANSWERS_ENV.find((name) => env[name] === undefined);
    if (missing !== undefined) throw new GatewayConfigError(missing);
    // Answers run on the company's own account, which lives in the product key store: no answers route without it.
    if (product === undefined) throw new GatewayConfigError(GATEWAY_ENV.productKeysTable);
    answers = { meter: table(GATEWAY_ENV.answersMeterTable), ledger: table(GATEWAY_ENV.answersLedgerTable), markers: table(GATEWAY_ENV.answersMarkersTable) };
  }
  // DEC 236: whose key the agent route sends. "company" needs the product key store (the company's connected key lives there).
  let agentKeys: GatewayAgentKeyMode | undefined;
  if (env[GATEWAY_ENV.agentKeys] !== undefined) {
    agentKeys = need(GATEWAY_ENV.agentKeys, (value) => (GATEWAY_AGENT_KEY_MODES as readonly string[]).includes(value)) as GatewayAgentKeyMode;
    if (agentKeys === "company" && product === undefined) throw new GatewayConfigError(GATEWAY_ENV.productKeysTable);
  }
  // DEC 240: Rovara's AI, only in company-key mode (the company picks its agents' source there). The exempt list never on its own.
  let rovaraAi: RovaraAiConfig | undefined;
  if (env[GATEWAY_ENV.rovaraAiModels] !== undefined) {
    if (agentKeys !== "company") throw new GatewayConfigError(GATEWAY_ENV.agentKeys);
    let models: Map<string, string>;
    try { models = parseRovaraAiModels(need(GATEWAY_ENV.rovaraAiModels, () => true), region); } catch { throw new GatewayConfigError(GATEWAY_ENV.rovaraAiModels); }
    let exempt: Set<string>;
    try { exempt = parseRovaraAiExempt(env[GATEWAY_ENV.rovaraAiExempt]); } catch { throw new GatewayConfigError(GATEWAY_ENV.rovaraAiExempt); }
    const sourceId = env[GATEWAY_ENV.rovaraAiSourceId] === undefined ? undefined : need(GATEWAY_ENV.rovaraAiSourceId,
      (value) => /^arn:aws(?:-us-gov|-cn)?:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]+@[a-z0-9-]+$/u.test(value) && value.endsWith(`@${region}`) && value.length <= 512);
    rovaraAi = { models, exempt, ...(sourceId === undefined ? {} : { sourceId }) };
  } else if (env[GATEWAY_ENV.rovaraAiExempt] !== undefined) throw new GatewayConfigError(GATEWAY_ENV.rovaraAiModels);
  // DEC 238: both settings or neither; only in company-key mode (the company picks its agents' source there) and with the product
  // MAC key (Cloud's signed set-up and connection test calls, service-call.ts).
  let bedrockByo: BedrockByoConfig | undefined;
  if (env[GATEWAY_ENV.bedrockBrokerRole] !== undefined || env[GATEWAY_ENV.bedrockExternalIdKey] !== undefined) {
    const brokerRoleArn = need(GATEWAY_ENV.bedrockBrokerRole, (value) => /^arn:aws:iam::\d{12}:role\/RovaraBedrockBroker-[a-z0-9-]{1,32}$/u.test(value));
    const externalIdKeyArn = need(GATEWAY_ENV.bedrockExternalIdKey, (value) => /^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/u.test(value));
    if (agentKeys !== "company") throw new GatewayConfigError(GATEWAY_ENV.agentKeys);
    if (product?.macKeyArn === undefined) throw new GatewayConfigError(GATEWAY_ENV.productMacKey);
    bedrockByo = { brokerRoleArn, externalIdKeyArn };
  }
  let agentModelsDisabled: ReadonlySet<string> | undefined;
  if (env[GATEWAY_ENV.agentModelsDisabled] !== undefined) {
    if (agentKeys !== "company") throw new GatewayConfigError(GATEWAY_ENV.agentKeys);
    try { agentModelsDisabled = parseDisabledAgentModels(env[GATEWAY_ENV.agentModelsDisabled]); } catch { throw new GatewayConfigError(GATEWAY_ENV.agentModelsDisabled); }
  }
  // DEC 254t: the switched-on company AI source kinds, only in company-key mode (where a company picks its agents' source).
  // DEC 254zzz96 (2): "on" only; any other value is a broken setting (never read as off or on by guess).
  const pricesSetting = env[GATEWAY_ENV.offeredPrices];
  if (pricesSetting !== undefined && pricesSetting !== "on") throw new GatewayConfigError(GATEWAY_ENV.offeredPrices);
  let aiSourceKinds: ReadonlySet<string> | undefined;
  if (env[GATEWAY_ENV.aiSourceKinds] !== undefined) {
    if (agentKeys !== "company") throw new GatewayConfigError(GATEWAY_ENV.agentKeys);
    try { aiSourceKinds = parseAiSourceKinds(env[GATEWAY_ENV.aiSourceKinds]); } catch { throw new GatewayConfigError(GATEWAY_ENV.aiSourceKinds); }
  }
  // Every table distinct: no two meters, stores or the stage table may share rows.
  const all = [tables.meter, tables.ledger, tables.markers, tables.prices, tables.companies, ...(product === undefined ? [] : [product.keysTable, product.meter, product.ledger, product.markers, product.stages]), ...(learning === undefined ? [] : [learning.meter, learning.ledger, learning.markers]), ...(answers === undefined ? [] : [answers.meter, answers.ledger, answers.markers])];
  if (new Set(all).size !== all.length) throw new GatewayConfigError(product === undefined ? GATEWAY_ENV.meterTable : learning === undefined ? GATEWAY_ENV.productMeterTable : answers === undefined ? GATEWAY_ENV.learningMeterTable : GATEWAY_ENV.answersMeterTable);
  return { mode, region, port, install: { issuer, jwksUrl, taskKids }, tables, anthropicKeySecret, ...(product === undefined ? {} : { product }), ...(learning === undefined ? {} : { learning }), ...(answers === undefined ? {} : { answers }), ...(agentKeys === undefined ? {} : { agentKeys }), ...(rovaraAi === undefined ? {} : { rovaraAi }), ...(bedrockByo === undefined ? {} : { bedrockByo }), ...(agentModelsDisabled === undefined ? {} : { agentModelsDisabled }), ...(aiSourceKinds === undefined ? {} : { aiSourceKinds }), ...(pricesSetting === "on" ? { offeredPrices: true as const } : {}) };
}

/** One JSON object per line on stdout, with an `event` field the alarms' metric filters count (deploy.ts GATEWAY_LOG_EVENTS). */
export type GatewayLog = (line: { event: string } & Record<string, string | number | boolean>) => void;
export function jsonLog(write: (text: string) => void = (text) => { process.stdout.write(text); }, now: () => number = Date.now): GatewayLog {
  return (line) => {
    try { write(`${JSON.stringify({ ...line, time: new Date(now()).toISOString() })}\n`); } catch { /* Logging never stops a call. */ }
  };
}

/**
 * For a model no price row gives a ceiling for (a model newer than the last price fetch): the most output tokens a request may
 * ask for, and what a request that names none is held at. Every model with a row uses the row's own max_output_tokens
 * (DEC 165/180: "the row's default max output").
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
export function modelLimitsFrom(rows: { maxOutputTokens(provider: string, model: string): number | undefined }): ModelLimitsSource {
  return { maxOutputTokens: (provider, model) => provider !== "anthropic" ? undefined : (rows.maxOutputTokens(provider, model) ?? DEFAULT_MAX_OUTPUT_TOKENS) };
}

/** A release drains a task for as long as one call may last (the load balancer's deregistration delay is the same hour). */
export const GATEWAY_DRAIN_MS = CALL_HARD_CEILING_MS;
/** Every five minutes: reload the prices table, then a bounded correction run and expiry sweep. */
export const MAINTENANCE_MS = 5 * 60_000;
/** Open holds closed per maintenance pass (bounded; the rest wait for the next pass). */
export const HOLD_SWEEP_PER_PASS = 50;

export interface ServeDependencies {
  /** The KMS client the deployed product key store opens keys with (default: aws-kms.ts with the task's credentials). */
  kms?: KmsLike & Partial<MacVerifier> & Partial<MacGenerator>;
  /** The HTTP the Bedrock broker and customer AssumeRole calls use (default: product-vertex-token.ts createTokenHttp, AWS STS hosts only). */
  bedrockHttp?: TokenHttp;
  /** DEC 238 slice 2: the product route's Bedrock transport for a connection's Region (default: product-bedrock.ts createBedrockProductTransport). */
  bedrockProductTransport?: (region: string, credentials: CredentialSource) => ProviderTransport;
  /** DEC 238: the company's own Bedrock for the agent route (default: built from config.bedrockByo over the product key store). */
  byoBedrock?: ByoBedrock;
  /** The HTTP the Vertex token minting uses (default: product-vertex-token.ts createTokenHttp, Google's and AWS's token hosts). */
  vertexHttp?: TokenHttp;
  /** The deployed product route's Gemini transport (default: product-gemini.ts createGeminiTransport over HTTPS). */
  geminiTransport?: ProviderTransport;
  env?: GatewayEnv; log?: GatewayLog; credentials?: CredentialSource; db?: Dynamo;
  fetch?: typeof fetch; transport?: ProviderTransport; keys?: ProviderKeys; caps?: CapsSource; modelLimits?: ModelLimitsSource;
  /**
   * The product-AI route (docs/model-gateway-product-ai.md): its resolver, its OWN meter (separate tables, combined with the agent
   * meter's company row and in-flight marker: DynamoMeterOptions.combinedCompany, DEC 228c) and its caps. Absent: every product path is 404. Its open holds, expiry and corrections run in
   * the same maintenance pass as the agent meter's.
   */
  product?: { routes: ProductRouteResolver; meter: Meter & Pick<DynamoMeter, "sweepOpenHolds">; caps: CapsSource; /** Eval stages (product-eval.ts): expired ones are released in the maintenance pass. */ stages?: Pick<ProductEvalStages, "sweep"> };
  /**
   * The learning route (DEC 226, learning-route.ts): the company's OWN provider account (`keys`, never the install key above), its
   * OWN meter combined with the agent meter's company row (DEC 228c), the company backend's budgets and lessons switch (the
   * Companies table). Absent: the learning path is 404. Its holds, expiry and corrections run in the same maintenance pass.
   */
  learning?: { keys: LearningKeySource; meter: Meter & Pick<DynamoMeter, "sweepOpenHolds">; monthCeilingMicros?: number /** Only for a company whose settings carry no learning cap (an older row); a company's own cap replaces it. */; /** The other providers' transports (default: the fixed Gemini, Vertex and OpenAI ones). */ transports?: NonNullable<LearningRouteOptions["transports"]> };
  /**
   * The answers route (L4-E, answers-route.ts): the company's OWN provider account (`keys`, the same source as learning's), its OWN meter combined with the agent
   * meter's company row (DEC 228c) and the company's answers limit (the Companies table). Absent: the answers path is 404. Its holds, expiry and corrections run in the
   * same maintenance pass.
   */
  answers?: { keys: LearningKeySource; meter: Meter & Pick<DynamoMeter, "sweepOpenHolds">; monthDefaultMicros?: number; transports?: NonNullable<LearningRouteOptions["transports"]> };
  /** Nightly upkeep's per-project limits and the company's answers limit (default: the Companies table, company-caps.ts). */
  upkeepLimits?: UpkeepLimits; answersLimits?: AnswersLimits;
  /** L4-HW3c: the company's approved rules for Code's hosted broker (company-instructions.ts). Default: Cloud's Companies table. */
  companyInstructions?: CompanyInstructionsSource;
  /**
   * DEC 236, with config.agentKeys "company": the company's OWN connected key for the agent route (default: the company source of the
   * product key store, the one the learning route reads). Never the install key (`keys`), which is then not read at all.
   */
  agentKeys?: LearningKeySource;
  /** DEC 240 in company-key mode: the companies' agent AI choices (default: Cloud's Companies table) and Bedrock (default: the fixed transport on the task role). */
  agentAiSources?: AgentAiSourceReader; bedrockTransport?: ProviderTransport;
  /** DEC 254t (A2): the own-key Chat Completions transports (default: agent-openai.ts createChatCompletionsTransport, fixed hosts). */
  openaiAgentTransport?: ProviderTransport; openrouterAgentTransport?: ProviderTransport;
  /** DEC 254t (A3): the endpoint transport per checked target (default: endpoint-source.ts createEndpointTransport). */
  endpointTransport?: (target: EndpointTarget, onRefused: (reason: "address" | "busy") => void, company: string) => ProviderTransport;
  now?: () => number; host?: string; port?: number; /** false: no listener (tests drive the server's request event). */ listen?: boolean; drainMs?: number; maintenanceMs?: number;
}
export interface RunningGateway { server: Server; port: number; draining(): boolean; drain(): Promise<void>; maintain(): Promise<void> }

const UNAVAILABLE = JSON.stringify({ error: { type: "unavailable", message: "model access unavailable" } });

/** DEC 228c: refuse to start with a product or learning meter that does not combine with THIS agent meter, or shares its tables. */
function checkMeters(config: ServeConfig, deps: ServeDependencies): void {
  // DEC 228c: one company monthly cap over every route. A product or learning meter that does not take the agent meter's company
  // row would let each route's spend reach the cap on its own: refuse to start rather than run it.
  type TableView = { combinedTables?: () => { meter: string; markers: string } | undefined; ownTables?: () => { meter: string; ledger: string; markers: string } };
  if (deps.product !== undefined && deps.product.meter.combinedCompany !== true) throw new Error("product meter must combine the company cap with the agent meter");
  if (deps.learning !== undefined && deps.learning.meter.combinedCompany !== true) throw new Error("learning meter must combine the company cap with the agent meter");
  if (deps.answers !== undefined && deps.answers.meter.combinedCompany !== true) throw new Error("answers meter must combine the company cap with the agent meter");
  // ...and the checks below need to SEE a meter's tables: a meter that cannot say which tables it combines with and owns (anything
  // but a DynamoMeter) would pass them unchecked, so a wired route's meter must expose both views (DEFERRED GATEWAY-LEARNING-FOLLOWUPS-2).
  const views = (name: "product" | "learning" | "answers", meter: unknown) => {
    const view = meter as TableView;
    const combined = typeof view.combinedTables === "function" ? view.combinedTables() : undefined;
    const own = typeof view.ownTables === "function" ? view.ownTables() : undefined;
    if (combined === undefined || own === undefined) throw new Error(`${name} meter must expose its tables`);
    // Combined with THIS agent meter's tables...
    if (combined.meter !== config.tables.meter || combined.markers !== config.tables.markers) throw new Error(`${name} meter must combine the company cap with the agent meter`);
    return own;
  };
  const productOwn = deps.product === undefined ? undefined : views("product", deps.product.meter);
  const learningOwn = deps.learning === undefined ? undefined : views("learning", deps.learning.meter);
  const answersOwn = deps.answers === undefined ? undefined : views("answers", deps.answers.meter);
  // ...and on tables of its own: never the agent's, and never another route's rows, holds or ledger.
  const agentTables = new Set([config.tables.meter, config.tables.ledger, config.tables.markers]);
  if (productOwn !== undefined && [productOwn.meter, productOwn.ledger, productOwn.markers].some((table) => agentTables.has(table))) throw new Error("product meter must have tables of its own");
  if (learningOwn !== undefined) {
    const taken = new Set([...agentTables, ...(productOwn === undefined ? [] : [productOwn.meter, productOwn.ledger, productOwn.markers])]);
    if ([learningOwn.meter, learningOwn.ledger, learningOwn.markers].some((table) => taken.has(table))) throw new Error("learning meter must have tables of its own");
  }
  if (answersOwn !== undefined) {
    const taken = new Set([...agentTables, ...(productOwn === undefined ? [] : [productOwn.meter, productOwn.ledger, productOwn.markers]), ...(learningOwn === undefined ? [] : [learningOwn.meter, learningOwn.ledger, learningOwn.markers])]);
    if ([answersOwn.meter, answersOwn.ledger, answersOwn.markers].some((table) => taken.has(table))) throw new Error("answers meter must have tables of its own");
  }
}

export async function startServe(config: ServeConfig, deps: ServeDependencies = {}): Promise<RunningGateway> {
  const log = deps.log ?? jsonLog();
  const now = deps.now ?? Date.now;
  const credentials = deps.credentials ?? credentialsFromEnvironment(deps.env ?? process.env);
  const db = deps.db ?? new Dynamo({ region: config.region, credentials });
  // Given meters are checked before anything is read; the deployed ones, built from the configured tables, again after.
  checkMeters(config, deps);
  const prices = new SnapshotPriceSource(new DynamoPriceSnapshotStore(db, config.tables.prices), { now });
  await prices.reload();
  const caps = deps.caps ?? new CompanyBudgetCaps(db, config.tables.companies);
  // The deployed product and learning routes, from the configured tables (deps.product / deps.learning still win: tests).
  const built = deployedRoutes(config, deps, { db, credentials, now, prices, caps });
  deps = { ...deps, ...(built.product === undefined ? {} : { product: built.product }), ...(built.learning === undefined ? {} : { learning: built.learning }), ...(built.answers === undefined ? {} : { answers: built.answers }), ...(built.agentKeys === undefined ? {} : { agentKeys: built.agentKeys }), ...(built.byo === undefined ? {} : { byoBedrock: built.byo.agent }) };
  // Company-key mode never starts without the company key source (no silent fallback to the install key).
  const companyKeys = config.agentKeys === "company" ? deps.agentKeys : undefined;
  if (config.agentKeys === "company" && companyKeys === undefined) throw new Error("company-key mode needs the company key store");
  checkMeters(config, deps);
  const meter = new DynamoMeter({ db, tables: config.tables, now });
  const modelLimits = deps.modelLimits ?? modelLimitsFrom(prices);
  const transport = deps.transport ?? createAnthropicTransport();
  // DEC 254zzz312: company-billed Rovara AI for learning and answers too; only configured exempt companies are free.
  const agentAiSources = deps.agentAiSources ?? new CompanyAgentAiSource(db, config.tables.companies);
  const rovaraBedrock: RovaraAi | undefined = config.rovaraAi === undefined ? undefined : {
    models: config.rovaraAi.models, exempt: config.rovaraAi.exempt, ...(config.rovaraAi.sourceId === undefined ? {} : { sourceId: config.rovaraAi.sourceId }),
    transport: deps.bedrockTransport ?? createBedrockTransport({ region: config.region, credentials, now }), maxOutputTokens: (id: string) => prices.maxOutputTokens("bedrock", id),
  };
  const rovaraDefault = companyKeys === undefined || rovaraBedrock === undefined ? {} : { rovaraDefault: { ai: rovaraBedrock, sources: agentAiSources, disabled: config.agentModelsDisabled ?? parseDisabledAgentModels(undefined), switchedOn: config.aiSourceKinds ?? new Set<string>() } };
  const learning = deps.learning === undefined ? undefined : createLearningRoutes({
    ...rovaraDefault,
    keys: deps.learning.keys, meter: deps.learning.meter, companyCaps: caps, lessons: new CompanyLessonsSwitch(db, config.tables.companies), transport,
    // Anthropic keeps the agent route's ceilings; the other providers' guards read their own price rows (and fall back to their own defaults).
    modelLimits: { maxOutputTokens: (provider, model) => provider === "anthropic" ? modelLimits.maxOutputTokens(provider, model) : prices.maxOutputTokens(provider, model) },
    transports: deps.learning.transports ?? { gemini: createGeminiTransport(), vertex: createVertexTransport(), openai: createOpenAiTransport() },
    ...(deps.learning.monthCeilingMicros === undefined ? {} : { monthCeilingMicros: deps.learning.monthCeilingMicros }),
  });
  const upkeepLimits = deps.upkeepLimits ?? new CompanyUpkeepLimits(db, config.tables.companies);
  const answers = deps.answers === undefined ? undefined : createAnswersRoutes({
    ...rovaraDefault,
    keys: deps.answers.keys, meter: deps.answers.meter, companyCaps: caps, limits: deps.answersLimits ?? new CompanyAnswersLimits(db, config.tables.companies), transport,
    modelLimits: { maxOutputTokens: (provider, model) => provider === "anthropic" ? modelLimits.maxOutputTokens(provider, model) : prices.maxOutputTokens(provider, model) },
    transports: deps.answers.transports ?? { gemini: createGeminiTransport(), vertex: createVertexTransport(), openai: createOpenAiTransport() },
    ...(deps.answers.monthDefaultMicros === undefined ? {} : { monthDefaultMicros: deps.answers.monthDefaultMicros }),
  });
  // The ended-task record: the server reads it on every agent call; the task-ended notice (task-ended-notice.ts) is the only writer.
  const endedTasks = new DynamoEndedTasks(db, config.tables.markers, now);
  const handlerDeps: GatewayDependencies = {
    rovaraAiSetting: new InstallRovaraAi(db, config.tables.companies, now),
    ...(companyKeys === undefined ? {} : { runPriceReady: () => prices.runPriceSnapshotVersion() }),
    // Only the route's admitted, revision-bound source can produce a receipt. Older adapters
    // without that evidence keep legacy provisional settlement; nothing is inferred from a token.
    chargeReceipts: { source: (_claims, _model, resolved) => resolved },
    verifyToken: createTaskTokenVerifier({ registry: new StaticInstallRegistry([config.install]), readJwks: createJwksReader(deps.fetch ?? fetch), now }),
    ended: endedTasks, meter, caps, prices, now,
    // The busy answer is counted from its log line (overrun_busy); the process needs no metrics permission.
    metrics: { overrunBusy: () => undefined },
    modelLimits,
    // Company-key mode: the install key is never read (a call can only go out on the company's own key, `agentKeys`).
    keys: companyKeys !== undefined ? NO_INSTALL_KEY : deps.keys ?? createSecretsManagerKeys({ region: config.region, credentials, secretArns: { anthropic: config.anthropicKeySecret }, now }),
    ...(companyKeys === undefined ? {} : { agentKeys: companyKeys }),
    // DEC 254zzz41: reviewer grants are claimed once, durably, in the markers table (company keys, TTL): company-key mode only.
    ...(companyKeys === undefined ? {} : { reviewerGrants: new DynamoReviewerGrants(db, config.tables.markers, now) }),
    // DEC 240: in company-key mode each company's saved choice picks its agents' source; Rovara's AI only when configured.
    ...(companyKeys === undefined ? {} : { agentAi: {
      sources: agentAiSources,
      ...(rovaraBedrock === undefined ? {} : { rovara: rovaraBedrock }),
      // DEC 238: only when configured (a company that chose its own Bedrock is refused otherwise, never sent elsewhere).
      ...(config.bedrockByo === undefined || deps.byoBedrock === undefined ? {} : { byo: deps.byoBedrock }),
      // DEC 254t: the kinds the owner switched on (none when unset).
      switchedOn: config.aiSourceKinds ?? new Set<string>(),
      // DEC 254zzz84(4): Rovara's AI models not enabled yet, so a company's saved order passes Rovara's AI over for them (the offered list leaves them out too).
      rovaraDisabled: config.agentModelsDisabled ?? parseDisabledAgentModels(undefined),
      // DEC 254t (A2): the company's own OpenAI and OpenRouter keys (fixed hosts), each held to its price row's output limit.
      openai: { transport: deps.openaiAgentTransport ?? createChatCompletionsTransport("openai"), maxOutputTokens: (model: string) => prices.maxOutputTokens("openai", model) },
      openrouter: { transport: deps.openrouterAgentTransport ?? createChatCompletionsTransport("openrouter"), maxOutputTokens: (model: string) => prices.maxOutputTokens("openrouter", model) },
      // DEC 254t (A3): the company's own endpoint behind the SSRF guard (system DNS at call time, pinned connection).
      endpoint: { transport: deps.endpointTransport ?? ((target, onRefused, company) => createEndpointTransport(target, { onRefused, company })), maxOutputTokens: (provider: string, model: string) => prices.maxOutputTokens(provider, model) },
    } }),
    transport,
    log: (event) => log({ ...event }),
    ...(deps.product === undefined ? {} : { product: deps.product.routes }),
    ...(learning === undefined ? {} : { learning }),
    ...(answers === undefined ? {} : { answers }),
    upkeep: upkeepLimits,
  };
  const handler = createGatewayHandler(handlerDeps);
  // Cloud's Vertex connection test (PRODUCT-VERTEX-CLOUD-CONNECT): only with Vertex, the MAC key and a KMS that can verify.
  const vertexCheck = built.vertex === undefined || built.verifier === undefined || config.product?.macKeyArn === undefined ? undefined
    : createVertexCheckHandler({ issuer: config.install.issuer, kms: built.verifier, macKeyId: config.product.macKeyArn, vertex: built.vertex, now });
  // DEC 238: Cloud's Bedrock set-up and connection test, only with BYO Bedrock built and a KMS that can verify Cloud's MAC.
  const bedrockCalls = built.byo?.service;
  // The models one company's agents may use (offered-models.ts), signed by the install's broker with its task key: company-key mode only.
  const offeredModels = companyKeys === undefined || handlerDeps.agentAi === undefined ? undefined : createOfferedModelsHandler({
    verify: createSignedTokenVerifier({ registry: new StaticInstallRegistry([config.install]), readJwks: createJwksReader(deps.fetch ?? fetch), now }, SERVICE_TOKEN_KIND),
    sources: handlerDeps.agentAi.sources, disabled: config.agentModelsDisabled ?? parseDisabledAgentModels(undefined),
    keys: companyKeys,
    ...(config.rovaraAi === undefined ? {} : { rovara: { models: config.rovaraAi.models, exempt: config.rovaraAi.exempt, ...(config.rovaraAi.sourceId === undefined ? {} : { sourceId: config.rovaraAi.sourceId }) } }),
    ...(config.bedrockByo === undefined || deps.byoBedrock === undefined ? {} : { byo: deps.byoBedrock }), now,
    switchedOn: config.aiSourceKinds ?? new Set<string>(), chat: { openai: true, openrouter: true },
    // DEC 254zzz96 (2): list prices on the offered list, only when switched on (display only).
    ...(config.offeredPrices === true ? { priceOf: (model: string, source: AgentAiSource | undefined) => offeredModelPrice(prices, model, source, config.rovaraAi?.models) } : {}),
    // DEC 254zzz41: what reviews may use, from the company's real connections and the room left in its one company cap (the agent meter's company row).
    reviewer: { keys: companyKeys, companyLimitMicros: (iss: string, cid: string) => companyRoomMicros(caps, meter, iss, cid) },
    // The endpoint's registered model names, from the company's sealed endpoint account (this company only).
    endpointModels: async (iss: string, cid: string) => { const text = await companyKeys.keyFor(iss, cid, "endpoint"); const c = text === undefined ? undefined : parseEndpointConnect(text); // An endpoint whose address the agent route's guard refuses offers nothing (the route would refuse it: review 1, Low 1).
      return c === undefined || endpointTarget(c.baseUrl) === undefined ? undefined : c.models.map((m) => m.name); },
  });
  // DEC 253k: Code's eval spend authority (eval-authority.ts), answered from the product route's eval stages (the stored approval,
  // the approver's role and the project's own key connection), signed by the install's broker with its task key. Only where the
  // product route holds eval stages; otherwise the path is the product route's 404.
  const authorityStages = (deps.product?.routes as { evalStages?: ProductEvalStages } | undefined)?.evalStages;
  const evalAuthority = authorityStages === undefined ? undefined : createEvalAuthorityHandler({
    verify: createSignedTokenVerifier({ registry: new StaticInstallRegistry([config.install]), readJwks: createJwksReader(deps.fetch ?? fetch), now }, EVAL_AUTHORITY_TOKEN_KIND),
    stages: authorityStages, now,
  });
  // DEC 253q (c): Code's eval monthly cap (eval-cap.ts), min(company, project) monthly cap from the company budget source the agent
  // calls read (`caps`: CompanyBudgetCaps over Cloud's Companies table unless a test gives its own), signed with the task key.
  const evalCap = createEvalCapHandler({
    verify: createSignedTokenVerifier({ registry: new StaticInstallRegistry([config.install]), readJwks: createJwksReader(deps.fetch ?? fetch), now }, EVAL_CAP_TOKEN_KIND),
    caps, now,
    // L4-T3: the project's own key connection, from the same stages the authority is answered from (absent where the route holds none: the answer then has no `connected`).
    ...(authorityStages === undefined ? {} : { connection: authorityStages }),
  });
  // L4-CAPR: Code's read of one project's nightly upkeep cap (upkeep-cap-read.ts), over the SAME limits the agent route enforces and the agent meter, signed with the task key.
  const upkeepCapRead = createUpkeepCapReadHandler({
    verify: createSignedTokenVerifier({ registry: new StaticInstallRegistry([config.install]), readJwks: createJwksReader(deps.fetch ?? fetch), now }, UPKEEP_CAP_READ_TOKEN_KIND),
    limits: upkeepLimits, meter, now,
  });
  // GATEWAY-RUN-CHARGES-ROUTE: Code's read of one run's actual charges (run-charges-read.ts), from the agent meter's receipts, signed with the task key.
  const runCharges = createRunChargesHandler({
    verify: createSignedTokenVerifier({ registry: new StaticInstallRegistry([config.install]), readJwks: createJwksReader(deps.fetch ?? fetch), now }, RUN_CHARGES_TOKEN_KIND),
    meter, now,
  });
  const rateQuote = companyKeys === undefined ? undefined : createRateQuoteHandler({
    verify: createSignedTokenVerifier({ registry: new StaticInstallRegistry([config.install]), readJwks: createJwksReader(deps.fetch ?? fetch), now }, RATE_QUOTE_TOKEN_KIND),
    sources: agentAiSources, keys: companyKeys, prices, region: config.region, now, disabled: config.agentModelsDisabled ?? parseDisabledAgentModels(undefined), switchedOn: config.aiSourceKinds ?? new Set<string>(),
    offeredProviders: new Set(["anthropic", ...(companyKeys === undefined ? [] : ["openai", "openrouter"]), ...(config.rovaraAi === undefined && (config.bedrockByo === undefined || handlerDeps.agentAi?.byo === undefined) ? [] : ["bedrock"])]),
    ...(config.rovaraAi === undefined ? {} : { rovara: { models: config.rovaraAi.models, exempt: config.rovaraAi.exempt, ...(config.rovaraAi.sourceId === undefined ? {} : { sourceId: config.rovaraAi.sourceId }) } }),
    ...(handlerDeps.agentAi?.byo === undefined ? {} : { byo: handlerDeps.agentAi.byo }),
  });
  // L4-HW3c: the company's approved rules for Code's hosted broker (company-instructions.ts), from Cloud's Companies table (the same read-only grant as the budgets), signed with the task key.
  const companyInstructions = createCompanyInstructionsHandler({
    verify: createSignedTokenVerifier({ registry: new StaticInstallRegistry([config.install]), readJwks: createJwksReader(deps.fetch ?? fetch), now }, COMPANY_INSTRUCTIONS_TOKEN_KIND),
    rules: deps.companyInstructions ?? new CompanyStoredInstructions(db, config.tables.companies), now,
  });
  // Code tells the gateway a task ended (closed or merged): the record above, written once and never undone (task-ended-notice.ts), signed with the task key.
  const taskEnded = createTaskEndedHandler({
    verify: createSignedTokenVerifier({ registry: new StaticInstallRegistry([config.install]), readJwks: createJwksReader(deps.fetch ?? fetch), now }, TASK_ENDED_TOKEN_KIND),
    ended: endedTasks, log: (line) => log({ ...line }), now,
  });
  const inFlight = new Set<Promise<void>>();
  let draining = false;
  const refuse = (res: ServerResponse) => { res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", connection: "close" }); res.end(UNAVAILABLE); };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    // Once draining, the health check fails and a new request (on a kept-alive connection) is refused; open calls finish.
    if (draining) { refuse(res); return; }
    const path = (req.url ?? "").split("?", 1)[0];
    const service = vertexCheck !== undefined && path === VERTEX_CHECK_PATH ? vertexCheck
      : bedrockCalls !== undefined && (path === BEDROCK_SETUP_PATH || path === BEDROCK_CHECK_PATH) ? bedrockCalls[path]
      : offeredModels !== undefined && OFFERED_MODELS_PATH.test(req.url ?? "") ? offeredModels
      : rateQuote !== undefined && RATE_QUOTE_PATH.test(req.url ?? "") ? rateQuote
      : UPKEEP_CAP_READ_PATH.test(req.url ?? "") ? upkeepCapRead
      : RUN_CHARGES_PATH.test(path ?? "") ? runCharges
      : evalAuthority !== undefined && path === EVAL_AUTHORITY_PATH ? evalAuthority
      : path === COMPANY_INSTRUCTIONS_PATH ? companyInstructions
      : path === TASK_ENDED_PATH ? taskEnded
      : path === EVAL_CAP_PATH ? evalCap : undefined;
    const running = (service !== undefined ? service(req, res) : handler(req, res)).catch(() => { if (!res.headersSent) refuse(res); else res.destroy(); });
    inFlight.add(running); void running.finally(() => inFlight.delete(running));
  });
  // The load balancer keeps idle connections for up to an hour; the target must keep them at least as long, or it would cut
  // a connection the balancer is about to reuse (a 502). A request's own time is bounded by handleGateway's deadline.
  server.keepAliveTimeout = (GATEWAY_DRAIN_MS / 1000 + 5) * 1000;
  server.headersTimeout = server.keepAliveTimeout + 1000;
  server.requestTimeout = 0;
  server.timeout = 0;
  if (deps.listen !== false) await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(deps.port ?? config.port, deps.host ?? "0.0.0.0", () => { server.off("error", reject); resolve(); }); });

  let maintaining: Promise<void> | undefined;
  const maintain = (): Promise<void> => {
    maintaining ??= (async () => {
      try {
        await prices.reload();
        const runId = randomUUID();
        const expiry = await runExpirySweep({ meter, now: now(), runId, log: (line) => log({ ...line }) });
        const corrections = await runCorrections({ meter, prices, caps, now: now(), runId, log: (line) => log({ ...line }) });
        // Holds whose settle never landed are closed at their estimate (never $0); a swept hold is logged, not alarmed.
        const holds = await meter.sweepOpenHolds(now(), HOLD_SWEEP_PER_PASS);
        if (holds.swept + holds.failed > 0) log({ event: "holds_swept", swept: holds.swept, failed: holds.failed, more: holds.more });
        if (deps.product !== undefined) {
          // The product meter: the same sweep, expiry and corrections, with the product caps. A failure here never stops the agent pass above.
          try {
            const p = deps.product;
            // Expired eval stages first (released at their own spend; a call still open keeps the whole hold), then the meter's
            // open holds: a stage hold is swept there only after its own end (ReserveInput.sweepAfter).
            // The stages the product route holds, also when only the route was given them (createProductRoutes evalStages).
            const routeStages = (p.routes as { evalStages?: Pick<ProductEvalStages, "sweep"> }).evalStages;
            for (const productStages of new Set([p.stages, routeStages])) {
              if (productStages === undefined) continue;
              const stages = await productStages.sweep(now());
              if (stages.released + stages.failed > 0) log({ event: "eval_stages_released", route: "product", released: stages.released, failed: stages.failed });
            }
            const productHolds = await p.meter.sweepOpenHolds(now(), HOLD_SWEEP_PER_PASS);
            if (productHolds.swept + productHolds.failed > 0) log({ event: "holds_swept", route: "product", swept: productHolds.swept, failed: productHolds.failed, more: productHolds.more });
            await runExpirySweep({ meter: p.meter, now: now(), runId, log: (line) => log({ ...line, route: "product" }) });
            await runCorrections({ meter: p.meter, prices, caps: p.caps, now: now(), runId, log: (line) => log({ ...line, route: "product" }) });
          } catch { log({ event: "maintenance_failed", route: "product" }); }
        }
        if (deps.learning !== undefined && learning !== undefined) {
          // The learning meter: the same sweep, expiry and corrections, with the learning caps. A failure never stops the passes above.
          try {
            const m = deps.learning.meter;
            const learningHolds = await m.sweepOpenHolds(now(), HOLD_SWEEP_PER_PASS);
            if (learningHolds.swept + learningHolds.failed > 0) log({ event: "holds_swept", route: "learning", swept: learningHolds.swept, failed: learningHolds.failed, more: learningHolds.more });
            await runExpirySweep({ meter: m, now: now(), runId, log: (line) => log({ ...line, route: "learning" }) });
            await runCorrections({ meter: m, prices, caps: learning.caps, now: now(), runId, log: (line) => log({ ...line, route: "learning" }) });
          } catch { log({ event: "maintenance_failed", route: "learning" }); }
        }
        if (deps.answers !== undefined && answers !== undefined) {
          // The answers meter: the same sweep, expiry and corrections, with the answers caps. A failure never stops the passes above.
          try {
            const m = deps.answers.meter;
            const answersHolds = await m.sweepOpenHolds(now(), HOLD_SWEEP_PER_PASS);
            if (answersHolds.swept + answersHolds.failed > 0) log({ event: "holds_swept", route: "answers", swept: answersHolds.swept, failed: answersHolds.failed, more: answersHolds.more });
            await runExpirySweep({ meter: m, now: now(), runId, log: (line) => log({ ...line, route: "answers" }) });
            await runCorrections({ meter: m, prices, caps: answers.caps, now: now(), runId, log: (line) => log({ ...line, route: "answers" }) });
          } catch { log({ event: "maintenance_failed", route: "answers" }); }
        }
        log({ event: "maintenance", corrected: corrections.corrected, skipped: corrections.skipped + expiry.skipped, expired: expiry.expired, unknown: corrections.unknown + expiry.unknown, more: corrections.more || expiry.more });
      } catch { log({ event: "maintenance_failed" }); }
      finally { maintaining = undefined; }
    })();
    return maintaining;
  };
  const timer = setInterval(() => { void maintain(); }, deps.maintenanceMs ?? MAINTENANCE_MS);
  timer.unref();

  let drained: Promise<void> | undefined;
  const drain = (): Promise<void> => {
    drained ??= (async () => {
      draining = true; clearInterval(timer);
      log({ event: "draining", open: inFlight.size });
      const closed = new Promise<void>((resolve) => { server.close(() => resolve()); });
      server.closeIdleConnections();
      const limit = setTimeout(() => { log({ event: "drain_timeout", open: inFlight.size }); server.closeAllConnections(); }, deps.drainMs ?? GATEWAY_DRAIN_MS);
      // Every open call ends (and settles: the settle runs in handleGateway's finally) before the process may exit.
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      server.closeIdleConnections();
      await closed;
      clearTimeout(limit);
      await maintaining?.catch(() => undefined);
      log({ event: "stopped" });
    })();
    return drained;
  };
  const port = deps.listen === false ? 0 : (server.address() as AddressInfo).port;
  log({ event: "started", mode: "serve", port });
  return { server, port, draining: () => draining, drain, maintain };
}

/** Company-key mode's install key: refuses every read (the agent route never asks it there; this is the second lock). */
const NO_INSTALL_KEY: ProviderKeys = { keyFor: async () => { throw new ProviderKeyUnavailable(); } };

/** The product key store's writes run in Cloud's settings routes; the gateway only reads keys and records warnings (no fingerprint). */
const READ_ONLY_FINGERPRINT: ProductKeyFingerprinter = async () => { throw new Error("the gateway does not change product keys"); };

/**
 * The deployed product route (key store over the product key table with its own KMS key, the product meter combined with the
 * agent meter's company row, the shared eval stage table, the production eval approvals and budgets, DynamoDB overrun marks,
 * Gemini over HTTPS with media prices) and the learning route (the company's own account from the same key store, its own meter
 * combined the same way). Nothing is built for settings that are absent.
 */
function deployedRoutes(config: ServeConfig, deps: ServeDependencies, shared: { db: Dynamo; credentials: CredentialSource; now: () => number; prices: SnapshotPriceSource; caps: CapsSource }): { product?: NonNullable<ServeDependencies["product"]>; learning?: NonNullable<ServeDependencies["learning"]>; answers?: NonNullable<ServeDependencies["answers"]>; vertex?: VertexTokens; verifier?: MacVerifier; agentKeys?: LearningKeySource; byo?: { agent: ByoBedrock; service?: ReturnType<typeof createBedrockServiceHandlers> } } {
  const p = config.product;
  const wantsAgentKeys = config.agentKeys === "company" && deps.agentKeys === undefined;
  const wantsByo = config.bedrockByo !== undefined && deps.byoBedrock === undefined;
  if (p === undefined || (deps.product !== undefined && (config.learning === undefined || deps.learning !== undefined) && (config.answers === undefined || deps.answers !== undefined) && !wantsAgentKeys && !wantsByo)) return {};
  const { db, now, prices, caps } = shared;
  const kms: KmsLike & Partial<MacVerifier> & Partial<MacGenerator> = deps.kms ?? awsKms({ region: config.region, credentials: shared.credentials, now });
  const verifier: MacVerifier | undefined = typeof kms.verifyMac === "function" ? { verifyMac: (input) => kms.verifyMac!(input) } : undefined;
  const store = new ProductKeyStore({ table: new DynamoProductKeyTable(db, p.keysTable), sealer: new ProductKeySealer(kmsProductKeyService(kms, p.keysKeyArn)), fingerprint: READ_ONLY_FINGERPRINT, now });
  const combinedCompany = { meter: config.tables.meter, markers: config.tables.markers };
  // DEC 238: the companies' own Bedrock: external ids from the gateway's own HMAC key, sessions through the broker role. The same
  // sessions serve the agent route and the product route (slice 2).
  let bedrockSessions: BedrockSessions | undefined; let bedrockExternalIds: BedrockExternalIds | undefined;
  if (config.bedrockByo !== undefined && (wantsByo || deps.product === undefined)) {
    if (typeof kms.generateMac !== "function") throw new Error("bring your own Bedrock needs a KMS that can make MACs");
    bedrockExternalIds = new BedrockExternalIds({ generateMac: (input) => kms.generateMac!(input) }, config.bedrockByo.externalIdKeyArn);
    bedrockSessions = new BedrockSessions({ http: deps.bedrockHttp ?? createTokenHttp(), aws: shared.credentials, brokerRoleArn: config.bedrockByo.brokerRoleArn, awsRegion: config.region, issuer: config.install.issuer, externalIds: bedrockExternalIds, now, log: deps.log });
  }
  let product: NonNullable<ServeDependencies["product"]> | undefined;
  let vertexTokens: VertexTokens | undefined;
  if (deps.product === undefined) {
    const productMeter = new DynamoMeter({ db, tables: { meter: p.meter, ledger: p.ledger, markers: p.markers }, now, combinedCompany });
    const evalStages = new ProductEvalStages({ approvals: storedEvalApprovals(store, now), budget: storedEvalBudget(store), now, store: new DynamoEvalStageStore(db, p.stages) });
    // Vertex (DEC 229b), only when the federation role is configured: tokens minted with this task's own credentials.
    const vertex = p.vertexFederationRoleArn === undefined ? undefined : new VertexTokens({ http: deps.vertexHttp ?? createTokenHttp(), aws: shared.credentials, federationRoleArn: p.vertexFederationRoleArn, awsRegion: config.region, now });
    const routes = createProductRoutes({
      keys: store, meter: productMeter, modelLimits: productModelLimitsFrom(prices), transports: { gemini: deps.geminiTransport ?? createGeminiTransport(), ...(vertex === undefined ? {} : { vertex: createVertexTransport() }) }, media: prices,
      ...(vertex === undefined ? {} : { vertex: { tokens: vertex } }),
      // Slice 2: the project's own role, or the company's it links to, through the same sessions as the agents' (the fixed Bedrock transport).
      ...(bedrockSessions === undefined ? {} : { bedrock: { sessions: bedrockSessions, transport: (region: string, credentials: CredentialSource) => deps.bedrockProductTransport?.(region, credentials) ?? createBedrockProductTransport({ region, credentials, now }) } }),
      overrun: new DynamoProductOverrunTasks(db, p.markers, now), companyCaps: caps, evalStages,
    });
    product = { routes, meter: productMeter, caps: routes.caps };
    vertexTokens = vertex;
  }
  let learning: NonNullable<ServeDependencies["learning"]> | undefined;
  if (config.learning !== undefined && deps.learning === undefined) {
    const l = config.learning;
    learning = { keys: storedLearningKeys(store), meter: new DynamoMeter({ db, tables: { meter: l.meter, ledger: l.ledger, markers: l.markers }, now, combinedCompany }) };
  }
  let answers: NonNullable<ServeDependencies["answers"]> | undefined;
  if (config.answers !== undefined && deps.answers === undefined) {
    const a = config.answers;
    answers = { keys: storedLearningKeys(store), meter: new DynamoMeter({ db, tables: { meter: a.meter, ledger: a.ledger, markers: a.markers }, now, combinedCompany }) };
  }
  // DEC 236: the agent route's company key is the same company-level source the learning route reads (provider "anthropic").
  const agentKeys = wantsAgentKeys ? storedLearningKeys(store) : undefined;
  // DEC 238: the companies' own Bedrock: external ids from the gateway's own HMAC key, sessions through the broker role.
  let byo: { agent: ByoBedrock; service?: ReturnType<typeof createBedrockServiceHandlers> } | undefined;
  if (wantsByo && config.bedrockByo !== undefined && bedrockSessions !== undefined && bedrockExternalIds !== undefined) {
    const externalIds = bedrockExternalIds; const sessions = bedrockSessions;
    byo = {
      agent: storedBedrock(store, sessions),
      ...(verifier === undefined || p.macKeyArn === undefined ? {} : { service: createBedrockServiceHandlers({ issuer: config.install.issuer, kms: verifier, macKeyId: p.macKeyArn, now, brokerRoleArn: config.bedrockByo.brokerRoleArn, externalIds, bedrock: sessions }) }),
    };
  }
  return {
    ...(byo === undefined ? {} : { byo }), ...(product === undefined ? {} : { product }), ...(learning === undefined ? {} : { learning }), ...(answers === undefined ? {} : { answers }), ...(vertexTokens === undefined ? {} : { vertex: vertexTokens }), ...(verifier === undefined ? {} : { verifier }), ...(agentKeys === undefined ? {} : { agentKeys }) };
}

export interface PriceFetchDependencies { env?: GatewayEnv; log?: GatewayLog; credentials?: CredentialSource; db?: Dynamo; fetch?: typeof fetch; now?: () => number }

/** One price fetch (the EventBridge rule's task). Writes only the prices table. Returns the process exit code. */
export async function runPriceFetch(config: PriceFetchConfig, deps: PriceFetchDependencies = {}): Promise<number> {
  const log = deps.log ?? jsonLog();
  try {
    const db = deps.db ?? new Dynamo({ region: config.region, credentials: deps.credentials ?? credentialsFromEnvironment(deps.env ?? process.env) });
    const store = new DynamoPriceSnapshotStore(db, config.tables.prices);
    const prices = new SnapshotPriceSource(store, deps.now === undefined ? {} : { now: deps.now });
    await prices.reload();
    const transport = fetchTransport(deps.fetch ?? fetch);
    const refresher = new PriceRefresher({
      store, prices,
      litellm: (previous) => fetchLiteLLM(transport, { previous }),
      aws: (previous) => fetchAWS(transport, { previous }),
      log: (line) => log({ ...line }),
    });
    const result = await refresher.run((deps.now ?? Date.now)());
    if (!result.ok) { log({ event: GATEWAY_LOG_EVENTS.priceFetchFailed }); return 1; }
    log({ event: GATEWAY_LOG_EVENTS.priceFetched, gained: result.gained });
    return 0;
  } catch { log({ event: GATEWAY_LOG_EVENTS.priceFetchFailed }); return 1; }
}

export interface ProcessHooks { onSignal(signal: "SIGTERM" | "SIGINT", handler: () => void): void; exit(code: number): void }

/** The whole process: read the settings, run the mode, drain on SIGTERM. A bad setting exits 2 with the variable's name logged. */
export async function runGateway(env: GatewayEnv, hooks: ProcessHooks, deps: ServeDependencies & PriceFetchDependencies = {}): Promise<RunningGateway | undefined> {
  const log = deps.log ?? jsonLog();
  let config: GatewayConfig;
  try { config = readGatewayConfig(env); }
  catch (error) { log({ event: "config_invalid", variable: error instanceof GatewayConfigError ? error.variable : "unknown" }); hooks.exit(2); return undefined; }
  if (config.mode === "price-fetch") { hooks.exit(await runPriceFetch(config, { ...deps, env, log })); return undefined; }
  let running: RunningGateway;
  try { running = await startServe(config, { ...deps, env, log }); }
  catch { log({ event: "start_failed" }); hooks.exit(1); return undefined; }
  const stop = () => { void running.drain().then(() => hooks.exit(0), () => hooks.exit(1)); };
  hooks.onSignal("SIGTERM", stop);
  hooks.onSignal("SIGINT", stop);
  return running;
}

