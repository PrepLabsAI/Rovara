/**
 * What the deployed gateway reads from its environment and writes to its log, shared with infra/lib/model-gateway.ts (which
 * repeats these literals; tests/contract/model-gateway-infra.test.ts holds the two to one truth). Constants only: process.ts
 * (the entry, main.ts) reads them; dynamo-meter.ts, dynamo-prices.ts and secrets.ts are the DynamoDB and Secrets Manager adapters.
 *
 * Settings come from plain environment variables. A provider key never does: the environment names the secret's ARN, and the
 * process reads the value from Secrets Manager at run time with its own role (migration plan v3.2, 7.4 item 4).
 */
export const GATEWAY_ENV = {
  /** "serve" (the HTTP service) or "price-fetch" (the daily price job, one run then exit). */
  mode: "GATEWAY_MODE",
  /** The port the HTTP service listens on, behind the load balancer. */
  port: "GATEWAY_PORT",
  /** The one Code install the gateway trusts (TC-1 `iss`), its pinned JWKS address and the task-token key IDs it accepts. */
  installIssuer: "GATEWAY_INSTALL_ISSUER",
  installJwksUrl: "GATEWAY_INSTALL_JWKS_URL",
  /** Comma-separated, at most two (one live, one being rotated in). */
  installTaskKids: "GATEWAY_INSTALL_TASK_KIDS",
  meterTable: "GATEWAY_METER_TABLE",
  ledgerTable: "GATEWAY_LEDGER_TABLE",
  markersTable: "GATEWAY_MARKERS_TABLE",
  pricesTable: "GATEWAY_PRICES_TABLE",
  /** The ARN of the secret holding the Anthropic key. Never the key itself. */
  anthropicKeySecret: "GATEWAY_ANTHROPIC_KEY_SECRET",
  /** The Cloud company backend's Companies table, read for each company's budgets (GATEWAY_COMPANY_SETTINGS). */
  companyTable: "GATEWAY_COMPANY_TABLE",
  /**
   * The product-AI route (docs/model-gateway-product-ai.md, "Deployed"): all eight set, or none (the route stays off, every
   * product path 404). The product key table (write-only key store, eval approvals and budgets), the ARN of its own KMS key, the
   * product meter's three tables and the shared eval stage table.
   */
  productKeysTable: "GATEWAY_PRODUCT_KEYS_TABLE",
  productKeysKey: "GATEWAY_PRODUCT_KEYS_KEY",
  productMeterTable: "GATEWAY_PRODUCT_METER_TABLE",
  productLedgerTable: "GATEWAY_PRODUCT_LEDGER_TABLE",
  productMarkersTable: "GATEWAY_PRODUCT_MARKERS_TABLE",
  evalStagesTable: "GATEWAY_EVAL_STAGES_TABLE",
  /**
   * Vertex AI on the product route (DEC 229b): the ARN of Rovara's federation role (no permissions; only this gateway's role
   * may assume it, with a company id as session name). Optional, only with the product route; absent: Vertex paths are 404.
   */
  vertexFederationRole: "GATEWAY_VERTEX_FEDERATION_ROLE",
  /**
   * The Vertex connection test Cloud asks for (PRODUCT-VERTEX-CLOUD-CONNECT, service-call.ts): the ARN of the product key store's
   * KMS HMAC key, whose MACs sign Cloud's calls (this gateway may only VerifyMac). Optional, only with the Vertex federation role;
   * absent: the test path is not served and a Vertex connect from Cloud answers unavailable.
   */
  productMacKey: "GATEWAY_PRODUCT_MAC_KEY",
  /** The learning route (docs/model-gateway-learning.md): its meter's three tables, set together and only with the product route (its key store). */
  learningMeterTable: "GATEWAY_LEARNING_METER_TABLE",
  learningLedgerTable: "GATEWAY_LEARNING_LEDGER_TABLE",
  learningMarkersTable: "GATEWAY_LEARNING_MARKERS_TABLE",
  /** The answers route (docs/model-gateway-learning.md ("The answers route")): its meter's three tables, set together and only with the product route (its key store). */
  answersMeterTable: "GATEWAY_ANSWERS_METER_TABLE",
  answersLedgerTable: "GATEWAY_ANSWERS_LEDGER_TABLE",
  answersMarkersTable: "GATEWAY_ANSWERS_MARKERS_TABLE",
  /**
   * Whose AI key the agent route sends (DEC 236): "company" (each company's own connected key from the product key store, only
   * with the product route; a company with none is refused, never sent on Rovara's key) or "install" (the install key above).
   * Absent: "install", as before.
   */
  agentKeys: "GATEWAY_AGENT_KEYS",
  /**
   * Rovara's AI (DEC 240), only with `agentKeys` "company": the allow-list `<agent model>=<bedrock id>,...` (agent-ai.ts
   * parseRovaraAiModels). Absent: Rovara's AI is off, and a company that chose it is refused.
   */
  rovaraAiSourceId: "GATEWAY_ROVARA_AI_SOURCE_ID",
  rovaraAiModels: "GATEWAY_ROVARA_AI_MODELS",
  /** The companies the operator named exempt from Rovara's AI charges (DEC 240b, the founders' test company), comma-separated. */
  rovaraAiExempt: "GATEWAY_ROVARA_AI_EXEMPT",
  /**
   * Models Rovara's AI lists but does not offer a company's agents yet (offered-models.ts): model names, comma-separated. Set but empty:
   * none held back. Absent: the default (the three Claude models that wait for the account's one-time Marketplace enable).
   */
  agentModelsDisabled: "GATEWAY_AGENT_MODELS_DISABLED",
  /**
   * Bring your own Bedrock (DEC 238), only with `agentKeys` "company" and the product MAC key: the ARN of Rovara's Bedrock broker
   * role (fixed name, retained; only this gateway's role may assume it, and it may only assume customers' RovaraBedrockInvoke-*
   * roles with an external id). Set together with `bedrockExternalIdKey`. Absent: a company that chose its own Bedrock is refused.
   */
  bedrockBrokerRole: "GATEWAY_BEDROCK_BROKER_ROLE",
  /** The ARN of the KMS HMAC key the companies' external ids are made with (only this gateway may GenerateMac; never replaced). */
  bedrockExternalIdKey: "GATEWAY_BEDROCK_EXTERNAL_ID_KEY",
  /**
   * DEC 254t: the company AI source kinds this install's owner switched on after each one's real-key check passed, comma-separated
   * (agent-ai.ts parseAiSourceKinds), only with `agentKeys` "company". Absent or empty: none (a company that chose an AI source of a
   * kind that is off is refused). Rovara's AI and the pre-switch sources (own Anthropic key, own Bedrock) are not gated by it.
   */
  aiSourceKinds: "GATEWAY_AI_SOURCE_KINDS",
  /**
   * DEC 254zzz96 (2): "on" publishes each offered model's list price on the offered-models answer (offered-models.ts `priceOf`). Absent: off, the answer
   * exactly as before. Switch it on only once the Code install's release accepts the optional price field (a Code release without it refuses the whole list).
   */
  offeredPrices: "GATEWAY_OFFERED_PRICES",
} as const;
/**
 * Standalone (self-hosted, issue #1554) env var names, kept separate from `GATEWAY_ENV` so Cloud's
 * `MODEL_GATEWAY_ENV` mirror in `infra/lib/model-gateway.ts` stays untouched.
 */
export const GATEWAY_STANDALONE_ENV = {
  /** Standalone budget caps in micro-dollars, used when GATEWAY_COMPANY_TABLE is absent. */
  defaultCompanyCapMicros: "GATEWAY_DEFAULT_COMPANY_CAP_MICROS",
  defaultProjectCapMicros: "GATEWAY_DEFAULT_PROJECT_CAP_MICROS",
  defaultTaskCapMicros: "GATEWAY_DEFAULT_TASK_CAP_MICROS",
  /** Optional provider key secret ARNs for standalone installs. Never the keys themselves. */
  openaiKeySecret: "GATEWAY_OPENAI_KEY_SECRET",
  openrouterKeySecret: "GATEWAY_OPENROUTER_KEY_SECRET",
  /** Standalone default AI provider ("bedrock" | "anthropic" | "openai" | "openrouter"). */
  standaloneProvider: "GATEWAY_STANDALONE_PROVIDER",
  /** "on" to seed the Prices table on cold start when empty (self-hosted installs). */
  seedPricesOnStart: "GATEWAY_SEED_PRICES_ON_START",
} as const;
/** The values of GATEWAY_STANDALONE_ENV.standaloneProvider. */
export const GATEWAY_STANDALONE_PROVIDERS = ["bedrock", "anthropic", "openai", "openrouter"] as const;
export type GatewayStandaloneProvider = typeof GATEWAY_STANDALONE_PROVIDERS[number];
/** The values of GATEWAY_ENV.agentKeys. */
export const GATEWAY_AGENT_KEY_MODES = ["install", "company"] as const;
export type GatewayAgentKeyMode = typeof GATEWAY_AGENT_KEY_MODES[number];
/** The product route's settings: all or none. */
export const GATEWAY_PRODUCT_ENV = [GATEWAY_ENV.productKeysTable, GATEWAY_ENV.productKeysKey, GATEWAY_ENV.productMeterTable, GATEWAY_ENV.productLedgerTable, GATEWAY_ENV.productMarkersTable, GATEWAY_ENV.evalStagesTable] as const;
/** The learning route's settings: all or none. */
export const GATEWAY_LEARNING_ENV = [GATEWAY_ENV.learningMeterTable, GATEWAY_ENV.learningLedgerTable, GATEWAY_ENV.learningMarkersTable] as const;
/** The answers route's settings: all or none. */
export const GATEWAY_ANSWERS_ENV = [GATEWAY_ENV.answersMeterTable, GATEWAY_ENV.answersLedgerTable, GATEWAY_ENV.answersMarkersTable] as const;

export const GATEWAY_MODES = ["serve", "price-fetch"] as const;
export const GATEWAY_PORT = 8080;

/**
 * Table shapes. Every key of the company tables starts with COMPANY_KEY_PREFIX followed by the install and company
 * (`CO#` + JSON.stringify([iss, cid]) ...), so the role's dynamodb:LeadingKeys condition can refuse any other key.
 * Only the markers table expires rows (the per-company in-flight marker, ADDENDUM-3 item 3, and the ended-task list); the
 * meter (spend, holds) and the ledger (per-call records, the estimated-call ledger) are kept with no expiry (DEC 222).
 */
export const GATEWAY_COMPANY_KEY_PREFIX = "CO#";
export const GATEWAY_TABLE_KEYS = { partitionKey: "pk", sortKey: "sk" } as const;
export const GATEWAY_MARKERS_TTL_ATTRIBUTE = "expiresAt";

/**
 * Log lines are one JSON object per line on stdout with an `event` field; the alarms count them with metric filters, so the
 * process needs no metrics permission. The first four are server.ts's own events; price_fetch_failed is the price job's.
 */
export const GATEWAY_LOG_EVENTS = {
  refused: "refused",
  overrunBusy: "overrun_busy",
  openRouterOverReservation: "openrouter_over_reservation",
  settleFailed: "settle_failed",
  providerError: "provider_error",
  priceFetchFailed: "price_fetch_failed",
  /** A price fetch that saved (counted daily; no count for three days raises the staleness alarm). */
  priceFetched: "price_fetched",
  /** #1583: a cold-start seed left this task with no prices, and a read of the shared table (which another task had seeded) gave it them. */
  priceReloadedAfterSeed: "price_reloaded_after_seed",
} as const;

/**
 * The ledger's two sparse indexes over estimated calls still waiting for a real price (R3c's pending-correction index). Only a
 * pending call carries `pendingAll` (one constant value), so the indexes hold nothing else and a corrected or expired call
 * leaves both. by-key orders by price key, then age (one price key's calls, and the distinct keys); by-age orders by age
 * across keys (the expiry sweep). The serving role may Query these two indexes by name, nothing else on them.
 */
export const GATEWAY_LEDGER_INDEXES = {
  pendingByKey: { name: "pending-by-key", partitionKey: "pendingAll", sortKey: "pendingKeyAt" },
  pendingByAge: { name: "pending-by-age", partitionKey: "pendingAll", sortKey: "pendingAt" },
} as const;
export const GATEWAY_PENDING_PARTITION = "PENDING";

/**
 * The meter's sparse index over holds still open (one constant partition, ordered by when the hold was taken). The sweep
 * (dynamo-meter.ts sweepOpenHolds) reads it to close holds whose settle failed; a settled hold leaves it.
 */
export const GATEWAY_METER_INDEXES = {
  openHolds: { name: "open-holds", partitionKey: "openAll", sortKey: "openAt" },
} as const;
export const GATEWAY_OPEN_PARTITION = "OPEN";

/**
 * The eval stage table's sparse index over stages whose parent hold is not settled yet, ordered by when the sweep should look at
 * them (dynamo-eval-stages.ts). The serving role may Query it by name.
 */
export const GATEWAY_EVAL_STAGE_INDEXES = {
  dueStages: { name: "due-stages", partitionKey: "dueAll", sortKey: "dueAt" },
} as const;
export const GATEWAY_EVAL_STAGE_PARTITION = "DUE";
/** The product key and eval stage tables' TTL attribute (key rows' purge time, receipts, stage rows). */
export const GATEWAY_PRODUCT_TTL_ATTRIBUTE = "expiresAt";

/**
 * Budgets come from the Cloud company backend's Companies table (packages/cloud-server company-dynamo.ts, #52): the item COMPANY#<org_…> / SETTINGS holds `companyId` and `settings.budgets`, four caps in
 * micro-dollars where null means no cap of that kind. The gateway only reads it (GetItem); the backend's admin API writes it.
 * These literals repeat that store's; tests/contract/model-gateway-company-budgets.test.ts writes through the backend's store
 * and reads back through the gateway's reader, so the two cannot drift.
 */
export const GATEWAY_COMPANY_SETTINGS = { partitionPrefix: "COMPANY#", sortKey: "SETTINGS" } as const;
/**
 * The company's agent AI choice (DEC 240) in the same Companies table: COMPANY#<org_…> / AGENT_AI, written by Cloud's
 * agent-ai-routes.ts (company admins, audited), read by the gateway (agent-ai.ts). A contract test writes through
 * Cloud's store and reads back through the gateway's reader.
 */
export const GATEWAY_COMPANY_AGENT_AI = { partitionPrefix: "COMPANY#", sortKey: "AGENT_AI" } as const;
/**
 * The company's spending-limit OVERRIDES (lead 3 row B1, DEC 254t b) in the same Companies table: one item per override, `COMPANY#<org_…>` /
 * `<sortPrefix><id>`, each `{ companyId, kind, id, monthlyUsdMicros, version, updatedAt, updatedBy }`. Written by Cloud's spend-limits-routes.ts
 * (company admins, audited), read by the gateway (company-caps.ts): no item is the company default (`settings.budgets`);
 * an item that does not read as exactly this company's, this kind's and this id's refuses the call.
 *
 * THIS IS THE TABLE OF KINDS on the gateway's side; Cloud's is SPEND_LIMIT_KINDS in cloud-server company-store.ts, and a contract test walks both
 * (tests/contract/model-gateway-spend-limits.test.ts). `scope` says which id of the call the limit is about (a project: the token's `pid`; a person:
 * its `per`). `caps` names the meter cap the limit replaces for a call (`projectMonth`, `personMonth`); null: no meter cap, the kind is enforced by its
 * own caller through `readSpendLimit` (company-caps.ts). A new kind is one entry here and one in Cloud's table.
 */
export const GATEWAY_COMPANY_SPEND_LIMITS = {
  partitionPrefix: "COMPANY#",
  kinds: [
    { kind: "project_month", scope: "project", sortPrefix: "SPEND_LIMIT#PROJECT#", caps: "projectMonth" },
    { kind: "person_month", scope: "person", sortPrefix: "SPEND_LIMIT#PERSON#", caps: "personMonth" },
    // Lead 4 L4-E: not meter caps; each is enforced by its own caller through readSpendLimit (upkeep-cap.ts, answers-route.ts).
    { kind: "upkeep_month", scope: "project", sortPrefix: "SPEND_LIMIT#UPKEEP#", caps: null },
    { kind: "answers_month", scope: "company", sortPrefix: "SPEND_LIMIT#ANSWERS#", caps: null },
  ],
} as const satisfies { partitionPrefix: string; kinds: readonly { kind: string; scope: "project" | "person" | "company"; sortPrefix: string; caps: "projectMonth" | "personMonth" | null }[] };
export const GATEWAY_COMPANY_BUDGET_FIELDS = ["companyMonthlyUsdMicros", "memberMonthlyUsdMicros", "projectMonthlyUsdMicros", "taskUsdMicros"] as const;
/** The backend's own ceiling for one budget: $1,000,000 in micro-dollars. */
export const GATEWAY_COMPANY_BUDGET_MAX = 1_000_000_000_000;
/**
 * The company's learning cap (DEC 226), a fifth budget in the same item: whole micro-dollars (never null), never above the company's
 * monthly cap in the backend. Absent in an older row: the learning default ($20) applies. Only the learning route reads it.
 */
export const GATEWAY_COMPANY_LEARNING_BUDGET_FIELD = "learningMonthlyUsdMicros";
/**
 * The company's lessons switch (DEC 226): the feature gate of this name in the same settings item (`settings.featureGates`), on
 * only when exactly true. The learning route reads it on every call; off, missing or anything else makes no learning call.
 */
export const GATEWAY_COMPANY_LESSONS_GATE = "lessons";
