import { createHash } from "node:crypto";
import {
  E2EModelRouteDefinitionSchema, E2E_AGENT_ELIGIBLE_MODELS, E2E_AGENT_RECOMMENDED_MODELS, E2E_AGENT_UNAVAILABLE_REASONS, E2E_DEFAULT_MODEL_ROUTE_ID, E2E_MODEL_ROUTE_CHANGED_REAPPROVE,
  E2E_MODEL_ROUTE_DEFAULT_BUDGETS, E2E_MODEL_SCRIPTED_ROUTE_PREFIX, KEYED_MODEL_PROVIDERS, MODEL_PROVIDERS, SECRET_ARN_PATTERN, canonicalJson, e2eAgentModelsFor, e2eModelRouteRevision,
  e2eModelRouteRevisionNumber, eligibleE2EAgentModel, isKeyedModelProvider,
  type E2EModelRouteDefinition, type EligibleE2EAgentModel, type ModelProvider,
} from "@agentx/contracts";

/**
 * The route of the AI browser-test agent that an installation's worker settings give (M1.4 Tasks 4.2 and 4.3a), and the check the worker makes of an admission's route
 * against its own settings. It is its own module (the `./e2e-route-derive` subpath) so the broker, which derives the same route, never loads pi-ai: it imports only contracts.
 * The broker and the worker call the same `deriveE2EAgentRoute`, so what the broker approved and what the worker serves cannot drift apart.
 */

/**
 * The small model the AI browser-test agent uses on each provider unless the installation chooses another, pinned in its route at setup approval (amendment A1). It lives in
 * contracts (`E2E_AGENT_RECOMMENDED_MODELS`, with the table of every model the route may be pinned to), so the broker and the CLI read it without pi-ai.
 * It is a separate choice from every coding role and is not a `ModelRole`: a role's default can fall back to Bedrock, and the e2e route never falls back. A test fails if the
 * pinned pi catalog lacks any of them.
 */
// A default model must show agreement AVAILABLE in `test-deploy --check` (ruling M4-U): a model with no agreement reports NOT_AVAILABLE and fails it.
export const DEFAULT_E2E_AGENT_MODELS = E2E_AGENT_RECOMMENDED_MODELS;

/** What the installation says about its worker's model, read from its worker settings (SSM `worker-model-provider`, `worker-<provider>-secret-arn`, `worker-openrouter-providers`). */
export interface E2EAgentInstallation {
  provider?: string | undefined;
  /** The configured secret ARN of the installation's provider (keyed providers only). An ARN, never a value. */
  secretArn?: string | undefined;
  /** `worker-openrouter-providers`: the comma-separated OpenRouter provider allowlist. */
  openRouterProviders?: string | undefined;
  /** The AWS region the Bedrock call goes to (the worker's region). */
  region?: string | undefined;
  /**
   * `worker-e2e-agent-model`: the model the installation chose for AI navigation. `default`, `none`, empty or absent mean Rovara's recommendation. Never taken from the worker's
   * boot environment: the worker searches the eligible models for the revision an admission names instead (`resolveE2EAgentRouteForAdmission`).
   */
  e2eModel?: string | undefined;
  /** The request shape the driving test found to work for the chosen model (the broker's `E2E_MODEL_ROUTE_SHAPE` row). Absent means the standard shape. */
  payloadShape?: "minimal" | undefined;
}

export type DerivedE2EAgentRoute =
  | { status: "available"; definition: E2EModelRouteDefinition }
  | { status: "unavailable"; reason: typeof E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved; detail: string };

const unavailable = (detail: string): Extract<DerivedE2EAgentRoute, { status: "unavailable" }> => ({ status: "unavailable", reason: E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved, detail });

/** What a provider's settings give a route of any model: the provider, its secret or region, and OpenRouter's routing policy. */
interface RouteBase {
  provider: ModelProvider;
  secretArn: string | null;
  region: string | null;
  openRouter: E2EModelRouteDefinition["openRouter"];
}

function routeBase(installation: E2EAgentInstallation): { status: "ok"; base: RouteBase } | Extract<DerivedE2EAgentRoute, { status: "unavailable" }> {
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
  return { status: "ok", base: { provider: modelProvider, secretArn, region, openRouter } };
}

/** The unparsed definition of `row` in `shape`: the minimal shape sends no effort. */
function definitionInput(base: RouteBase, row: EligibleE2EAgentModel, shape: "standard" | "minimal", revision: number) {
  return {
    routeId: E2E_DEFAULT_MODEL_ROUTE_ID, revision, scope: "standard", provider: base.provider, region: base.region, modelId: row.modelId, inferenceProfileArn: null, secretArn: base.secretArn,
    openRouter: base.openRouter, budgets: { ...E2E_MODEL_ROUTE_DEFAULT_BUDGETS }, promptProtocol: "e2e-0.20.0-act/v1", sampling: "provider-default", thinking: "off",
    effort: shape === "minimal" ? null : row.effort, vision: false, ...(shape === "minimal" ? { payloadShape: "minimal" } : {}),
  };
}

function parsedDefinition(base: RouteBase, row: EligibleE2EAgentModel, shape: "standard" | "minimal", revision: number): DerivedE2EAgentRoute {
  const parsed = E2EModelRouteDefinitionSchema.safeParse(definitionInput(base, row, shape, revision));
  return parsed.success ? { status: "available", definition: parsed.data } : unavailable(`the installation's settings do not make a valid route: ${parsed.error.issues[0]?.message ?? "invalid"}`);
}

/** The recommended model's table row. It is not held to the region rule of a chosen model: a default install keeps the route it has always had, and a Bedrock profile of another geography fails closed at the call. */
function recommendedRow(provider: ModelProvider): EligibleE2EAgentModel | undefined {
  const modelId = E2E_AGENT_RECOMMENDED_MODELS[provider];
  return E2E_AGENT_ELIGIBLE_MODELS.find((row) => row.provider === provider && row.modelId === modelId);
}

const isBuiltInChoice = (setting: string | undefined): boolean => setting === undefined || ["", "default", "none"].includes(setting.trim());

/**
 * The route the installation's settings give, as revision `revision`: the installation's chosen model (`e2eModel`), or Rovara's recommendation when it chose none. A provider
 * without what it needs (a secret, a region) has no route, and agent steps stay unavailable. A chosen model the table does not list for this provider and region has no route
 * either, and the sentence never carries the setting's value.
 */
export function deriveE2EAgentRoute(installation: E2EAgentInstallation, revision = 1): DerivedE2EAgentRoute {
  const base = routeBase(installation);
  if (base.status === "unavailable") return base;
  const label = base.base.provider === "amazon-bedrock" ? "Amazon Bedrock" : KEYED_MODEL_PROVIDERS[base.base.provider].label;
  const chosen = isBuiltInChoice(installation.e2eModel) ? undefined : installation.e2eModel?.trim();
  const row = chosen === undefined || chosen === E2E_AGENT_RECOMMENDED_MODELS[base.base.provider] ? recommendedRow(base.base.provider) : eligibleE2EAgentModel(base.base.provider, chosen, base.base.region);
  if (row === undefined || row === null) return unavailable(`the chosen AI navigation model is not one Rovara can use with ${label} in this region`);
  return parsedDefinition(base.base, row, installation.payloadShape === "minimal" ? "minimal" : "standard", revision);
}

/**
 * The route of one named model in one request shape, whatever the installation's setting says: what the worker's search tries (D-2) and what a model check drives (Task 4.10C). An
 * id the table does not list for this provider and region has no route.
 */
export function deriveE2EAgentRouteForModel(installation: E2EAgentInstallation, modelId: string, shape: "standard" | "minimal", revision: number): DerivedE2EAgentRoute {
  const base = routeBase(installation);
  if (base.status === "unavailable") return base;
  const row = modelId === E2E_AGENT_RECOMMENDED_MODELS[base.base.provider] ? recommendedRow(base.base.provider) : eligibleE2EAgentModel(base.base.provider, modelId, base.base.region);
  if (row === undefined || row === null) return unavailable("that model is not one Rovara can use with this provider in this region");
  return parsedDefinition(base.base, row, shape, revision);
}

/**
 * The digest of what the route is, apart from its revision number: equal digests are the same route. The broker keys approvals and the canary row
 * (`E2E_MODEL_ROUTE_CANARY#<routeId>#<definitionDigest>`) by it, and the worker's model canary (Task 4.9) reports the digest of the route it called.
 */
export function e2eAgentRouteDefinitionDigest(definition: E2EModelRouteDefinition): string {
  const parsed = E2EModelRouteDefinitionSchema.parse(definition);
  const withoutRevision = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "revision"));
  return createHash("sha256").update(canonicalJson(withoutRevision), "utf8").digest("hex");
}

/**
 * The installation as a worker sees itself, from its process environment: `AGENTX_MODEL_PROVIDER` (unset is Bedrock, as for the coding agent), a keyed provider's secret-ARN
 * variable, `AGENTX_OPENROUTER_PROVIDERS` and the worker's region. The broker reads the same four settings from SSM (`e2eAgentInstallationFromParameters`).
 */
export function e2eAgentInstallationFromEnvironment(environment: NodeJS.ProcessEnv = process.env): E2EAgentInstallation {
  const setting = (name: string): string | undefined => { const value = environment[name]?.trim(); return value === undefined || value === "" || value === "none" ? undefined : value; };
  const provider = setting("AGENTX_MODEL_PROVIDER") ?? "amazon-bedrock";
  const secretArn = isKeyedModelProvider(provider) ? setting(KEYED_MODEL_PROVIDERS[provider].secretArnVariable) : undefined;
  const openRouterProviders = setting("AGENTX_OPENROUTER_PROVIDERS");
  const region = setting("AWS_REGION") ?? setting("AWS_DEFAULT_REGION");
  return {
    provider,
    ...(secretArn === undefined ? {} : { secretArn }),
    ...(openRouterProviders === undefined ? {} : { openRouterProviders }),
    ...(region === undefined ? {} : { region }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The scripted model double's route
// ---------------------------------------------------------------------------------------------------------------------

export const SCRIPTED_E2E_ROUTE_ID = "rovara-scripted/v1";
export const SCRIPTED_E2E_MODEL_ID = "rovara-scripted-v1";

/** The scripted route is admitted only for a qualification policy, or when the CI harness sets `ROVARA_E2E_SCRIPTED_MODEL=1`. The registry refuses it for project setups. */
export function isScriptedE2EModelAdmissible(input: { policyScope: "standard" | "qualification"; environment: NodeJS.ProcessEnv }): boolean {
  return input.policyScope === "qualification" || input.environment["ROVARA_E2E_SCRIPTED_MODEL"] === "1";
}

export function scriptedE2ERouteDefinition(overrides: Partial<Pick<E2EModelRouteDefinition, "revision" | "budgets">> = {}): E2EModelRouteDefinition {
  return E2EModelRouteDefinitionSchema.parse({
    routeId: SCRIPTED_E2E_ROUTE_ID, revision: 1, scope: "qualification", provider: "rovara-scripted", region: null,
    modelId: SCRIPTED_E2E_MODEL_ID, inferenceProfileArn: null, secretArn: null, openRouter: null, budgets: { ...E2E_MODEL_ROUTE_DEFAULT_BUDGETS },
    promptProtocol: "e2e-0.20.0-act/v1", sampling: "provider-default", thinking: "off", effort: null, vision: false, ...overrides,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The worker's check of an admission's route (Ruling DB-7)
// ---------------------------------------------------------------------------------------------------------------------

export type ResolvedE2EAgentRoute =
  | { ok: true; definition: E2EModelRouteDefinition }
  | { ok: false; code: typeof E2E_MODEL_ROUTE_CHANGED_REAPPROVE | typeof E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved; detail: string };

/** The most routes the worker's search builds for one admission. Today's table holds fewer than 300 eligible models on any provider, in two shapes each. */
export const E2E_AGENT_ROUTE_SEARCH_LIMIT = 1_000;

/**
 * The definition, among the models eligible for the provider and region (the recommended model first) in both request shapes at the admission's revision number, whose revision is
 * the one the admission names; undefined when none is. Bounded at `E2E_AGENT_ROUTE_SEARCH_LIMIT` candidates. Never takes a definition from the admission: it makes each one itself.
 */
export function searchE2EAgentRoute(installation: E2EAgentInstallation, provider: ModelProvider, revisionNumber: number, routeRevision: string): E2EModelRouteDefinition | undefined {
  const recommended = E2E_AGENT_RECOMMENDED_MODELS[provider];
  const ids = [recommended, ...e2eAgentModelsFor(provider, installation.region ?? null).map((row) => row.modelId).filter((modelId) => modelId !== recommended)];
  let tried = 0;
  for (const modelId of ids) {
    for (const shape of ["standard", "minimal"] as const) {
      if (tried >= E2E_AGENT_ROUTE_SEARCH_LIMIT) return undefined;
      tried += 1;
      const derived = deriveE2EAgentRouteForModel(installation, modelId, shape, revisionNumber);
      if (derived.status === "available" && e2eModelRouteRevision(derived.definition) === routeRevision) return derived.definition;
    }
  }
  return undefined;
}

/**
 * The definition (at revision 1, in either request shape) of an eligible model of the provider whose digest is `definitionDigest`, or undefined: how a model check finds the route it
 * was asked to test without taking a definition from the request. Bounded like `searchE2EAgentRoute`.
 */
export function searchE2EAgentRouteByDigest(installation: E2EAgentInstallation, provider: ModelProvider, definitionDigest: string): E2EModelRouteDefinition | undefined {
  const recommended = E2E_AGENT_RECOMMENDED_MODELS[provider];
  const ids = [recommended, ...e2eAgentModelsFor(provider, installation.region ?? null).map((row) => row.modelId).filter((modelId) => modelId !== recommended)];
  let tried = 0;
  for (const modelId of ids) {
    for (const shape of ["standard", "minimal"] as const) {
      if (tried >= E2E_AGENT_ROUTE_SEARCH_LIMIT) return undefined;
      tried += 1;
      const derived = deriveE2EAgentRouteForModel(installation, modelId, shape, 1);
      if (derived.status === "available" && e2eAgentRouteDefinitionDigest(derived.definition) === definitionDigest) return derived.definition;
    }
  }
  return undefined;
}

/**
 * Re-derives, from the worker's own settings, the route an admission names, and holds it to the admission's revision. The worker never takes a definition from the admission or
 * the executor: it makes its own, and serves it only when its digest is the revision the broker approved and the project's policy pinned.
 *
 * - A revision the worker's settings do not reproduce (another provider, secret ARN, region or OpenRouter policy; an admission redelivered after a settings change) is
 *   `model-route-changed-reapprove`.
 * - A route the worker's settings cannot make at all, a route id this worker does not serve, or a scripted route outside a qualification policy (or without
 *   `ROVARA_E2E_SCRIPTED_MODEL=1`) is `agent-route-not-approved`.
 * - A `rovara-scripted/` route id maps to the scripted definition, so CI admissions can name it (Ruling DB-7).
 * The detail is a fixed sentence: it never carries a value from the environment.
 */
export function resolveE2EAgentRouteForAdmission(
  modelRoute: { routeId: string; routeRevision: string },
  options: { environment?: NodeJS.ProcessEnv; policyScope: "standard" | "qualification" },
): ResolvedE2EAgentRoute {
  const environment = options.environment ?? process.env;
  const refuse = (code: Extract<ResolvedE2EAgentRoute, { ok: false }>["code"], detail: string): ResolvedE2EAgentRoute => ({ ok: false, code, detail });
  const revisionNumber = e2eModelRouteRevisionNumber(modelRoute.routeRevision);
  if (revisionNumber === null) return refuse(E2E_MODEL_ROUTE_CHANGED_REAPPROVE, "the admission's route revision is not readable");
  let definition: E2EModelRouteDefinition;
  if (modelRoute.routeId.startsWith(E2E_MODEL_SCRIPTED_ROUTE_PREFIX)) {
    if (modelRoute.routeId !== SCRIPTED_E2E_ROUTE_ID) return refuse(E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved, "this worker does not serve that route");
    if (!isScriptedE2EModelAdmissible({ policyScope: options.policyScope, environment })) {
      return refuse(E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved, "the scripted model route is admitted only under a qualification policy or with ROVARA_E2E_SCRIPTED_MODEL=1");
    }
    definition = scriptedE2ERouteDefinition({ revision: revisionNumber });
  } else {
    if (modelRoute.routeId !== E2E_DEFAULT_MODEL_ROUTE_ID) return refuse(E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved, "this worker does not serve that route");
    // The worker's boot environment names the provider, secret and region, not the model: it searches the eligible models for the revision the admission names (D-2).
    const installation = e2eAgentInstallationFromEnvironment(environment);
    const derived = deriveE2EAgentRoute(installation, revisionNumber);
    if (derived.status === "unavailable") return refuse(E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved, derived.detail);
    const found = searchE2EAgentRoute(installation, derived.definition.provider as ModelProvider, revisionNumber, modelRoute.routeRevision);
    if (found === undefined) return refuse(E2E_MODEL_ROUTE_CHANGED_REAPPROVE, "the AI navigation settings of this worker are not the ones this route was approved with");
    definition = found;
  }
  if (e2eModelRouteRevision(definition) !== modelRoute.routeRevision) {
    return refuse(E2E_MODEL_ROUTE_CHANGED_REAPPROVE, "the AI navigation settings of this worker are not the ones this route was approved with");
  }
  return { ok: true, definition };
}
