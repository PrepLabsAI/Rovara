import { createHash } from "node:crypto";
import {
  E2EModelRouteDefinitionSchema, E2E_AGENT_UNAVAILABLE_REASONS, E2E_DEFAULT_MODEL_ROUTE_ID, E2E_MODEL_ROUTE_CHANGED_REAPPROVE, E2E_MODEL_ROUTE_DEFAULT_BUDGETS,
  E2E_MODEL_SCRIPTED_ROUTE_PREFIX, KEYED_MODEL_PROVIDERS, MODEL_PROVIDERS, SECRET_ARN_PATTERN, canonicalJson, e2eModelRouteRevision, e2eModelRouteRevisionNumber, isKeyedModelProvider,
  type E2EModelRouteDefinition, type ModelProvider,
} from "@agentx/contracts";

/**
 * The route of the AI browser-test agent that an installation's worker settings give (M1.4 Tasks 4.2 and 4.3a), and the check the worker makes of an admission's route
 * against its own settings. It is its own module (the `./e2e-route-derive` subpath) so the broker, which derives the same route, never loads pi-ai: it imports only contracts.
 * The broker and the worker call the same `deriveE2EAgentRoute`, so what the broker approved and what the worker serves cannot drift apart.
 */

/**
 * The small model the AI browser-test agent uses on each provider, pinned in its route at setup approval (amendment A1).
 * It is a separate choice from every coding role and is not a `ModelRole`: a role's default can fall back to Bedrock,
 * and the e2e route never falls back. The OpenRouter id is provisional until a canary on an OpenRouter installation
 * records the model OpenRouter reports serving it (owner item O5). A test fails if the pinned pi catalog lacks any of them.
 */
// A default model must show agreement AVAILABLE in `test-deploy --check` (ruling M4-U): a model with no agreement reports NOT_AVAILABLE and fails it.
export const DEFAULT_E2E_AGENT_MODELS = {
  "amazon-bedrock": "us.anthropic.claude-haiku-5-5",
  anthropic: "claude-haiku-5-5",
  openrouter: "anthropic/claude-haiku-5.5",
  openai: "gpt-5.4-mini",
} as const satisfies Record<ModelProvider, string>;

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
    const derived = deriveE2EAgentRoute(e2eAgentInstallationFromEnvironment(environment), revisionNumber);
    if (derived.status === "unavailable") return refuse(E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved, derived.detail);
    definition = derived.definition;
  }
  if (e2eModelRouteRevision(definition) !== modelRoute.routeRevision) {
    return refuse(E2E_MODEL_ROUTE_CHANGED_REAPPROVE, "the AI navigation settings of this worker are not the ones this route was approved with");
  }
  return { ok: true, definition };
}
