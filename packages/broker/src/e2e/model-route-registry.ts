import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  E2EModelRouteDefinitionSchema, E2E_AGENT_UNAVAILABLE_REASONS, E2E_HARD_LIMITS, E2E_DEFAULT_MODEL_ROUTE_ID, E2E_MODEL_ROUTE_CHANGED_REAPPROVE, E2E_MODEL_ROUTE_DEFAULT_BUDGETS,
  INDEX_EXPIRY_ATTRIBUTE, KEYED_MODEL_PROVIDERS, MODEL_PROVIDERS, SECRET_ARN_PATTERN, WORKER_SETTING_PARAMETERS, canonicalJson, indexExpiresAt, e2eModelRouteRevision, isKeyedModelProvider,
  type E2EModelRouteDefinition, type ModelProvider,
} from "@agentx/contracts";
import { DEFAULT_E2E_AGENT_MODELS } from "@agentx/model-runtime/config";
import type { E2EDayBudget, E2EDayLimits, E2EDayReservation } from "@agentx/model-runtime";

/**
 * The model route registry and the project's day budget for the AI browser-test agent (M1.4 Task 4.2), in the broker's one state table.
 *
 * The route is the installation's: its provider is the installation's worker provider (`worker-model-provider`, the worker's `AGENTX_MODEL_PROVIDER`), its model is
 * `DEFAULT_E2E_AGENT_MODELS[provider]`, and a keyed provider's secret is the ARN the installation already configures for the worker (`worker-<provider>-secret-arn`), the
 * ARN only and never the value. Nothing here reads a secret.
 *
 * Rows (a fixed partition, so approval state is read by key and a deploy check needs no project and no Scan):
 * - `E2E_MODEL_ROUTES / E2E_MODEL_ROUTE#<routeId>#REV#<n>`: the definition of revision n, written once and never changed;
 * - `E2E_MODEL_ROUTES / E2E_MODEL_ROUTE_LATEST#<routeId>`: `{ revisionNumber, revision, definitionDigest }`, moved only from the previous revision;
 * - `E2E_MODEL_ROUTES / E2E_MODEL_ROUTE_CANARY#<routeId>#<definitionDigest>`: written by the live canary (Task 4.9) for a provisional route;
 * - `PROJECT#<project> / E2E_MODEL_BUDGET#<yyyy-mm-dd>`: `{ inputTokens, calls }` of the project's UTC day, moved only by conditional increments.
 * None of these is a membership row or a project revision row, and nothing here writes to either.
 */

export const E2E_MODEL_ROUTE_PARTITION = "E2E_MODEL_ROUTES" as const;

export const e2eModelRouteRevisionKey = (routeId: string, revisionNumber: number) => ({ pk: E2E_MODEL_ROUTE_PARTITION, sk: `E2E_MODEL_ROUTE#${routeId}#REV#${revisionNumber}` });
export const e2eModelRouteLatestKey = (routeId: string) => ({ pk: E2E_MODEL_ROUTE_PARTITION, sk: `E2E_MODEL_ROUTE_LATEST#${routeId}` });
export const e2eModelRouteCanaryKey = (routeId: string, definitionDigest: string) => ({ pk: E2E_MODEL_ROUTE_PARTITION, sk: `E2E_MODEL_ROUTE_CANARY#${routeId}#${definitionDigest}` });
export const e2eModelBudgetKey = (projectName: string, day: string) => ({ pk: `PROJECT#${projectName}`, sk: `E2E_MODEL_BUDGET#${day}` });

export interface E2EModelRouteStore {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
}

/** What the installation says about its worker's model, read from its worker settings (SSM `worker-model-provider`, `worker-<provider>-secret-arn`, `worker-openrouter-providers`). */
export interface E2EAgentInstallation {
  provider?: string | undefined;
  /** The configured secret ARN of the installation's provider (keyed providers only). An ARN, never a value. */
  secretArn?: string | undefined;
  /** `worker-openrouter-providers`: the comma-separated OpenRouter provider allowlist. */
  openRouterProviders?: string | undefined;
  /** The AWS region the Bedrock call goes to (the worker's region). */
  region?: string | undefined;
}

/**
 * Reads the installation's worker model settings from the SSM parameters under its settings prefix (`/agentx/<env>/`): the provider, a keyed provider's secret ARN and the
 * OpenRouter allowlist. They hold an id and an ARN, never a secret. A value that is absent or `none` is not configured. `read` returns the values found by parameter name.
 */
export async function e2eAgentInstallationFromParameters(
  prefix: string,
  read: (names: readonly string[]) => Promise<ReadonlyMap<string, string>>,
  region: string | undefined,
): Promise<E2EAgentInstallation> {
  const names = {
    provider: `${prefix}${WORKER_SETTING_PARAMETERS.modelProvider}`,
    openRouterProviders: `${prefix}${WORKER_SETTING_PARAMETERS.openRouterProviders}`,
    ...Object.fromEntries(Object.entries(KEYED_MODEL_PROVIDERS).map(([provider, row]) => [provider, `${prefix}${WORKER_SETTING_PARAMETERS[row.workerSetting]}`])),
  } as Record<string, string>;
  const values = await read(Object.values(names));
  const setting = (name: string): string | undefined => { const value = values.get(name)?.trim(); return value === undefined || value === "" || value === "none" ? undefined : value; };
  const provider = setting(names.provider!);
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(provider !== undefined && isKeyedModelProvider(provider) && setting(names[provider]!) !== undefined ? { secretArn: setting(names[provider]!)! } : {}),
    ...(setting(names.openRouterProviders!) === undefined ? {} : { openRouterProviders: setting(names.openRouterProviders!)! }),
    ...(region === undefined || region === "" ? {} : { region }),
  };
}

/** A provider whose small-model id has not been shown live: its route stays unapproved until a canary on an installation of that provider records one (owner decision O5). */
const PROVISIONAL_PROVIDERS: ReadonlySet<string> = new Set(["openrouter"]);

export type DerivedE2EAgentRoute =
  | { status: "available"; definition: E2EModelRouteDefinition }
  | { status: "unavailable"; reason: typeof E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved; detail: string };

const unavailable = (detail: string): Extract<DerivedE2EAgentRoute, { status: "unavailable" }> => ({ status: "unavailable", reason: E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved, detail });

/** The route the installation's settings give, as revision `revision`. A provider without what it needs (a secret, a region) has no route, and agent steps stay unavailable. */
export function deriveE2EAgentRoute(installation: E2EAgentInstallation, revision = 1): DerivedE2EAgentRoute {
  const provider = installation.provider;
  if (provider === undefined || provider === "") return unavailable("the installation has no model provider setting");
  if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) return unavailable(`${provider} is not a provider an installation can configure`);
  const modelProvider = provider as ModelProvider;
  let secretArn: string | null = null;
  let region: string | null = null;
  let openRouter: E2EModelRouteDefinition["openRouter"] = null;
  if (isKeyedModelProvider(modelProvider)) {
    const label = KEYED_MODEL_PROVIDERS[modelProvider].label;
    if (installation.secretArn === undefined || installation.secretArn === "") return unavailable(`${label} has no configured secret, so there is no key for the AI navigation model`);
    if (!SECRET_ARN_PATTERN.test(installation.secretArn)) return unavailable(`the configured ${label} secret is not a Secrets Manager ARN`);
    secretArn = installation.secretArn;
    if (modelProvider === "openrouter") {
      const only = (installation.openRouterProviders ?? "").split(",").map((name) => name.trim()).filter(Boolean);
      if (only.some((name) => !/^[a-z0-9][a-z0-9_/-]{0,79}$/.test(name))) return unavailable("the OpenRouter provider allowlist must be comma-separated provider slugs");
      openRouter = { allowFallbacks: false, requireParameters: true, dataCollection: "deny", only };
    }
  } else {
    if (installation.region === undefined || installation.region === "") return unavailable("the Bedrock region of the installation is unknown");
    region = installation.region;
  }
  const parsed = E2EModelRouteDefinitionSchema.safeParse({
    routeId: E2E_DEFAULT_MODEL_ROUTE_ID, revision, scope: "standard", provider: modelProvider, region, modelId: DEFAULT_E2E_AGENT_MODELS[modelProvider], inferenceProfileArn: null, secretArn, openRouter,
    budgets: { ...E2E_MODEL_ROUTE_DEFAULT_BUDGETS }, promptProtocol: "e2e-0.20.0-act/v1", sampling: "provider-default", thinking: "off", effort: modelProvider === "openai" ? null : "low", vision: false,
  });
  return parsed.success ? { status: "available", definition: parsed.data } : unavailable(`the installation's settings do not make a valid route: ${parsed.error.issues[0]?.message ?? "invalid"}`);
}

/**
 * The policy limits a project that pins this route runs under (D2). The round holds a group's model requests, tokens and time to them, so they come from the route's budgets: a
 * group may make `maxModelCallsPerGroup` requests and use `maxInputTokensPerGroup` input tokens and that many calls' output allowance; a case may hold the most agent steps a group
 * allows (their actions and step deadlines) beside its deterministic steps, within the hard limits. A setup that pins no route keeps the small model-free limits.
 */
export function e2eAgentRoutePolicyLimits(budgets: E2EModelRouteDefinition["budgets"]) {
  const agentActions = budgets.maxAgentStepsPerGroup * budgets.maxActionsPerStep;
  return {
    runTimeoutMs: 1_200_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000,
    caseTimeoutMs: Math.min(E2E_HARD_LIMITS.caseTimeoutMs, budgets.maxAgentStepsPerGroup * budgets.stepDeadlineMs + 30_000),
    maxActionsPerCase: Math.min(E2E_HARD_LIMITS.maxActionsPerCase, agentActions + 30),
    maxModelRequests: budgets.maxModelCallsPerGroup, maxInputTokens: budgets.maxInputTokensPerGroup,
    maxOutputTokens: Math.min(E2E_HARD_LIMITS.maxOutputTokens, budgets.maxModelCallsPerGroup * budgets.maxOutputTokens), maxSpendUsd: null,
  };
}

/** The digest of what the route is, apart from its revision number: equal digests are the same route, so approval writes a new revision only when it changes. */
export function e2eAgentRouteDefinitionDigest(definition: E2EModelRouteDefinition): string {
  const parsed = E2EModelRouteDefinitionSchema.parse(definition);
  const withoutRevision = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "revision"));
  return createHash("sha256").update(canonicalJson(withoutRevision), "utf8").digest("hex");
}

const LABELS: Record<ModelProvider, string> = { "amazon-bedrock": "Amazon Bedrock", openrouter: "OpenRouter", anthropic: "Anthropic", openai: "OpenAI" };

/** The sentence the setup proposal shows the administrator. */
export function agentRouteSummary(definition: E2EModelRouteDefinition): string {
  const provider = definition.provider as ModelProvider;
  return `AI navigation: ${LABELS[provider] ?? provider} \`${definition.modelId}\`; at most ${definition.budgets.maxActionsPerStep} actions per step; checks decide`;
}

export class E2EModelRouteError extends Error {
  constructor(readonly code: typeof E2E_MODEL_ROUTE_CHANGED_REAPPROVE | typeof E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved, message: string) {
    super(`${code}: ${message}`);
    this.name = "E2EModelRouteError";
  }
}

export interface E2EModelRouteLatest {
  routeId: string;
  revisionNumber: number;
  revision: string;
  definitionDigest: string;
}

/** The newest revision of the route, by a strongly consistent GetItem. */
export async function readE2EModelRouteLatest(store: E2EModelRouteStore, routeId: string = E2E_DEFAULT_MODEL_ROUTE_ID): Promise<E2EModelRouteLatest | null> {
  const response = await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: e2eModelRouteLatestKey(routeId), ConsistentRead: true }));
  const item = response.Item as Record<string, unknown> | undefined;
  if (item === undefined) return null;
  if (!Number.isSafeInteger(item.revisionNumber) || (item.revisionNumber as number) < 1 || typeof item.revision !== "string" || typeof item.definitionDigest !== "string") {
    throw new E2EModelRouteError("agent-route-not-approved", "the stored latest route revision cannot be read");
  }
  return { routeId, revisionNumber: item.revisionNumber as number, revision: item.revision, definitionDigest: item.definitionDigest };
}

async function hasCanary(store: E2EModelRouteStore, routeId: string, definitionDigest: string): Promise<boolean> {
  const response = await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: e2eModelRouteCanaryKey(routeId, definitionDigest), ConsistentRead: true }));
  return response.Item !== undefined;
}

export type PlannedE2EAgentRoute =
  | { status: "available"; definition: E2EModelRouteDefinition; definitionDigest: string; revision: string; revisionNumber: number; unchanged: boolean }
  | { status: "unavailable"; reason: typeof E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved; detail: string };

/**
 * The route the installation would have approved now, and the revision it would be: the latest revision when the definition is unchanged, else the next. Reads only, by key.
 * A provisional provider's route is unavailable until its canary row exists for this exact definition.
 */
export async function planE2EAgentRoute(store: E2EModelRouteStore, installation: E2EAgentInstallation): Promise<PlannedE2EAgentRoute> {
  const derived = deriveE2EAgentRoute(installation, 1);
  if (derived.status === "unavailable") return { status: "unavailable", reason: derived.reason, detail: derived.detail };
  const definitionDigest = e2eAgentRouteDefinitionDigest(derived.definition);
  if (PROVISIONAL_PROVIDERS.has(derived.definition.provider) && !(await hasCanary(store, derived.definition.routeId, definitionDigest))) {
    return unavailable(`the ${LABELS[derived.definition.provider as ModelProvider]} AI navigation model is provisional until a canary call on this installation has been recorded`);
  }
  const latest = await readE2EModelRouteLatest(store, derived.definition.routeId);
  if (latest !== null && latest.definitionDigest === definitionDigest) {
    const definition = E2EModelRouteDefinitionSchema.parse({ ...derived.definition, revision: latest.revisionNumber });
    return { status: "available", definition, definitionDigest, revision: e2eModelRouteRevision(definition), revisionNumber: latest.revisionNumber, unchanged: true };
  }
  const revisionNumber = (latest?.revisionNumber ?? 0) + 1;
  const definition = E2EModelRouteDefinitionSchema.parse({ ...derived.definition, revision: revisionNumber });
  return { status: "available", definition, definitionDigest, revision: e2eModelRouteRevision(definition), revisionNumber, unchanged: false };
}

const isConditionalFailure = (error: unknown): boolean => {
  const name = error instanceof Error ? error.name : "";
  return name === "ConditionalCheckFailedException" || name === "TransactionCanceledException";
};

/**
 * Setup approval's write: records the route the installation has now as revision n+1, only when its digest differs from the latest, and returns its revision id.
 * `expectedRevision` is the revision the administrator was shown (from `planE2EAgentRoute`); a different revision now (the installation's settings changed, or another
 * approval won the race for revision n+1) is `model-route-changed-reapprove`, and nothing is written. The row and the latest pointer go in one transaction, conditioned on
 * the pointer still being the one read: a revision row is never overwritten, and a lost race re-reads and re-judges.
 */
export async function approveE2EAgentRoute(store: E2EModelRouteStore, installation: E2EAgentInstallation, expectedRevision: string, options: { approvedAt?: string; approvedBy?: string; projectName?: string } = {}):
  Promise<{ revision: string; revisionNumber: number; written: boolean }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const planned = await planE2EAgentRoute(store, installation);
    if (planned.status === "unavailable") throw new E2EModelRouteError("agent-route-not-approved", planned.detail);
    if (planned.revision !== expectedRevision) throw new E2EModelRouteError(E2E_MODEL_ROUTE_CHANGED_REAPPROVE, "the AI navigation settings changed since the setup was proposed; propose the setup again and approve it");
    if (planned.unchanged) return { revision: planned.revision, revisionNumber: planned.revisionNumber, written: false };
    const routeId = planned.definition.routeId;
    const previous = planned.revisionNumber - 1;
    const approvedAt = options.approvedAt ?? new Date().toISOString();
    try {
      await store.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: store.tableName, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)", Item: {
          ...e2eModelRouteRevisionKey(routeId, planned.revisionNumber), entityType: "E2E_MODEL_ROUTE", routeId, revisionNumber: planned.revisionNumber, revision: planned.revision,
          definitionDigest: planned.definitionDigest, definition: planned.definition, approvedAt,
          ...(options.approvedBy === undefined ? {} : { approvedBy: options.approvedBy }), ...(options.projectName === undefined ? {} : { projectName: options.projectName }) } } },
        previous === 0
          ? { Put: { TableName: store.tableName, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)", Item: {
            ...e2eModelRouteLatestKey(routeId), entityType: "E2E_MODEL_ROUTE_LATEST", routeId, revisionNumber: planned.revisionNumber, revision: planned.revision,
            definitionDigest: planned.definitionDigest, approvedAt } } }
          : { Update: { TableName: store.tableName, Key: e2eModelRouteLatestKey(routeId),
            UpdateExpression: "SET revisionNumber = :next, revision = :revision, definitionDigest = :digest, approvedAt = :approvedAt",
            ConditionExpression: "revisionNumber = :previous", ExpressionAttributeValues: { ":next": planned.revisionNumber, ":revision": planned.revision,
              ":digest": planned.definitionDigest, ":approvedAt": approvedAt, ":previous": previous } } },
      ] }));
      return { revision: planned.revision, revisionNumber: planned.revisionNumber, written: true };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      // Another approval moved the pointer first: read again and judge against what is there now.
    }
  }
  throw new E2EModelRouteError(E2E_MODEL_ROUTE_CHANGED_REAPPROVE, "the AI navigation settings were being changed while the setup was approved; propose the setup again");
}

export type E2EAgentRouteCheck =
  | { ok: true; routeId: string; routeRevision: string }
  | { ok: false; code: typeof E2E_MODEL_ROUTE_CHANGED_REAPPROVE | typeof E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved; detail: string };

/**
 * Dispatch's check (and planning's): derives the route from the installation again and compares it with what the registry holds and what the project's policy pinned.
 * Any change of provider, model, secret ARN or OpenRouter policy gives `model-route-changed-reapprove`; a route the installation can no longer make, or none ever approved,
 * is `agent-route-not-approved`. Reads by key only.
 */
export async function checkE2EAgentRouteCurrent(store: E2EModelRouteStore, installation: E2EAgentInstallation, policyRevision: string | null): Promise<E2EAgentRouteCheck> {
  const latest = await readE2EModelRouteLatest(store);
  if (latest === null) return { ok: false, code: "agent-route-not-approved", detail: "no AI navigation route has been approved for this installation" };
  if (policyRevision === null) return { ok: false, code: "agent-route-not-approved", detail: "the project's setup was approved without AI navigation" };
  const derived = deriveE2EAgentRoute(installation, latest.revisionNumber);
  if (derived.status === "unavailable") return { ok: false, code: "agent-route-not-approved", detail: derived.detail };
  if (e2eAgentRouteDefinitionDigest(derived.definition) !== latest.definitionDigest) {
    return { ok: false, code: E2E_MODEL_ROUTE_CHANGED_REAPPROVE, detail: "The AI navigation settings changed; approve the checks again" };
  }
  if (policyRevision !== latest.revision) return { ok: false, code: E2E_MODEL_ROUTE_CHANGED_REAPPROVE, detail: "The AI navigation settings changed since this project's setup was approved; approve the checks again" };
  return { ok: true, routeId: latest.routeId, routeRevision: latest.revision };
}

// ---------------------------------------------------------------------------------------------------------------------
// The project's day budget
// ---------------------------------------------------------------------------------------------------------------------

const utcDay = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

export interface BrokerE2EDayBudgetOptions extends E2EModelRouteStore {
  projectName: string;
  /** Milliseconds since the epoch. Injected so tests control the UTC day. */
  now: () => number;
}

const positiveWhole = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/**
 * The broker-backed day budget the governed route reserves from and settles to (`E2EDayBudget` in model-runtime). One row per project and UTC day.
 *
 * - `reserve` is one conditional increment of the tokens and one call: it succeeds only while neither day cap in `limits` would be passed, so two racing reserves can never
 *   both take the last room. A cap that would be passed gives null. Anything that stops the increment being recorded (a throttle, a fault, a bad argument) throws, which the route
 *   treats as an exhausted budget: a reserve that cannot be recorded fails closed and the provider is never called.
 * - `settle(actual)` corrects the reservation of a call that was sent to what it is charged, once: the call stays counted and the tokens are trued up (an overrun in full). It
 *   takes a positive whole amount only; the route never settles zero (a sent call that reports none is charged the reserved bound).
 * - `release()` is for a call that was never sent (a refusal, or a failure before any request went out): it gives back both the reserved tokens and the call count.
 * - A correction that cannot be recorded throws and leaves the reservation in place, and no counter can be driven below zero.
 * - The reservation settles the row of the day it was made on, even if the settle crosses midnight.
 * - Each row expires through the State table's TTL attribute (`indexExpiresAt`), a retention period after its day.
 */
export function createBrokerE2EDayBudget(options: BrokerE2EDayBudgetOptions): E2EDayBudget {
  return {
    async reserve(inputTokens: number, limits: E2EDayLimits): Promise<E2EDayReservation | null> {
      if (!positiveWhole(inputTokens)) throw new Error("a day budget reserve needs a positive whole number of input tokens");
      if (!positiveWhole(limits.maxInputTokens) || !positiveWhole(limits.maxCalls)) throw new Error("a day budget reserve needs positive day limits");
      // Without room for even this call on an empty day, nothing could ever be reserved.
      if (inputTokens > limits.maxInputTokens) return null;
      const day = utcDay(options.now());
      const key = e2eModelBudgetKey(options.projectName, day);
      try {
        await options.documentClient.send(new UpdateCommand({
          TableName: options.tableName, Key: key,
          UpdateExpression: "ADD #tokens :reserved, #calls :one SET entityType = :entityType, #expires = :expires",
          ConditionExpression: "(attribute_not_exists(#tokens) OR #tokens <= :tokenRoom) AND (attribute_not_exists(#calls) OR #calls <= :callRoom)",
          ExpressionAttributeNames: { "#tokens": "inputTokens", "#calls": "calls", "#expires": INDEX_EXPIRY_ATTRIBUTE },
          ExpressionAttributeValues: { ":reserved": inputTokens, ":one": 1, ":entityType": "E2E_MODEL_BUDGET", ":tokenRoom": limits.maxInputTokens - inputTokens, ":callRoom": limits.maxCalls - 1,
            ":expires": indexExpiresAt(`${day}T23:59:59.000Z`) },
        }));
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") return null;
        throw error;
      }
      let done = false;
      return {
        async settle(actualInputTokens: number): Promise<void> {
          if (done) return;
          if (!positiveWhole(actualInputTokens)) throw new Error("a day budget settle needs a positive whole number of input tokens");
          const delta = actualInputTokens - inputTokens;
          if (delta !== 0) {
            // The row must exist and hold at least what is taken back, so a counter can never go below zero.
            await options.documentClient.send(new UpdateCommand({
              TableName: options.tableName, Key: key, UpdateExpression: "ADD #tokens :delta",
              ConditionExpression: "attribute_exists(pk) AND #tokens >= :tokenFloor",
              ExpressionAttributeNames: { "#tokens": "inputTokens" },
              ExpressionAttributeValues: { ":delta": delta, ":tokenFloor": delta < 0 ? -delta : 0 },
            }));
          }
          done = true;
        },
        async release(): Promise<void> {
          if (done) return;
          await options.documentClient.send(new UpdateCommand({
            TableName: options.tableName, Key: key, UpdateExpression: "ADD #tokens :minusTokens, #calls :minusOne",
            ConditionExpression: "attribute_exists(pk) AND #tokens >= :tokenFloor AND #calls >= :callFloor",
            ExpressionAttributeNames: { "#tokens": "inputTokens", "#calls": "calls" },
            ExpressionAttributeValues: { ":minusTokens": -inputTokens, ":minusOne": -1, ":tokenFloor": inputTokens, ":callFloor": 1 },
          }));
          done = true;
        },
      };
    },
  };
}

/**
 * Dispatch's precheck for a group that uses the model: whether the project's day has room for the group's worst case (`need`) under the day caps. A read by key; the
 * per-call reservations above are what actually hold the caps. False gives UNKNOWN `model-route-budget-exhausted` before the run starts.
 */
export async function e2eDayBudgetRoom(
  options: E2EModelRouteStore & { projectName: string; now: number },
  need: { inputTokens: number; calls: number },
  limits: E2EDayLimits,
): Promise<boolean> {
  const response = await options.documentClient.send(new GetCommand({ TableName: options.tableName, Key: e2eModelBudgetKey(options.projectName, utcDay(options.now)), ConsistentRead: true }));
  const item = response.Item as { inputTokens?: unknown; calls?: unknown } | undefined;
  const usedTokens = typeof item?.inputTokens === "number" ? item.inputTokens : 0;
  const usedCalls = typeof item?.calls === "number" ? item.calls : 0;
  return usedTokens + need.inputTokens <= limits.maxInputTokens && usedCalls + need.calls <= limits.maxCalls;
}
