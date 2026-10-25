import { randomUUID } from "node:crypto";
import { E2E_MODEL_CHANNEL_SCHEMA_VERSION, E2EModelReceiptSchema, e2eModelRouteRevision, type E2EModelChannelRequest, type E2EModelReceipt } from "@agentx/contracts";
import {
  E2EPayloadRefusedError,
  assertE2EEnvironmentCannotRedirect,
  assertE2ESharedAwsConfigCannotRedirect,
  createE2EProviderInvoke,
  createGovernedE2EModelRoute,
  deriveE2EAgentRoute,
  e2eAgentInstallationFromEnvironment,
  e2eAgentRouteDefinitionDigest,
  type E2EDayBudget,
  type E2EInvoke,
} from "@agentx/model-runtime";
import { createE2ECredentialGuard } from "./e2e-model-credential-guard.js";

/**
 * The model canary (M1.4 Task 4.9 step 3, decision D1): the first real model call, made by the worker on the qualified runner, through the very route the AI navigation agent uses.
 *
 * It runs inside the worker container (`docker exec ... e2e-model-canary-cli.js`, started by the boot qualification hook only when the operator's
 * `scripts/test-model-canary.ts --apply` has put a request under the runner's own transport prefix), so it calls the provider from the runner's subnet with the worker's own
 * settings and instance role, and the environment guard holds exactly as it does for an agent step. It:
 *
 * 1. takes a request that names the route the operator planned (its id and definition digest) and the bounds, which it can only restate, never raise: at most one call, at most
 *    32,000 input tokens, at most 1,024 output tokens;
 * 2. derives the route from the worker's own settings, and refuses when its digest is not the one planned (the canary row is keyed by what was really called);
 * 3. refuses when the environment or the shared AWS files could redirect the call;
 * 4. makes one call of a fixed prompt through `createGovernedE2EModelRoute` (pinned identifier, thinking off, effort, timeout, bounds, answer checks) over a budget that holds one
 *    call, with the proxy's credential scan on the final payload;
 * 5. returns the receipt, the payload digest and the counts. No prompt or answer text is returned or logged.
 */

export const E2E_MODEL_CANARY_REQUEST_SCHEMA = "rovara-e2e-model-canary-request/v1" as const;
export const E2E_MODEL_CANARY_RESULT_SCHEMA = "rovara-e2e-model-canary-result/v1" as const;
export const E2E_MODEL_CANARY_BOUNDS = Object.freeze({ maxCalls: 1, maxInputTokens: 32_000, maxOutputTokens: 1024 } as const);
export const E2E_MODEL_CANARY_CASE_ID = "model-canary";
/** How long the one call may take, whatever the route allows. */
const CANARY_DEADLINE_MS = 60_000;

/** The fixed call: a short system sentence and a short question, no tools. Nothing from the page, the run or the operator is in it. */
export const E2E_MODEL_CANARY_CALL: E2EModelChannelRequest["call"] = Object.freeze({
  prompt: [
    { role: "system", content: "You are the Rovara model canary, a connectivity check. Answer with the single word OK." },
    { role: "user", content: [{ type: "text", text: "Reply with OK." }] },
  ],
  maxOutputTokens: 64,
}) as E2EModelChannelRequest["call"];

export interface E2EModelCanaryRequest {
  schemaVersion: typeof E2E_MODEL_CANARY_REQUEST_SCHEMA;
  canaryId: string;
  routeId: string;
  definitionDigest: string;
  maxCalls: typeof E2E_MODEL_CANARY_BOUNDS.maxCalls;
  maxInputTokens: typeof E2E_MODEL_CANARY_BOUNDS.maxInputTokens;
  maxOutputTokens: typeof E2E_MODEL_CANARY_BOUNDS.maxOutputTokens;
}

const REQUEST_KEYS = ["canaryId", "definitionDigest", "maxCalls", "maxInputTokens", "maxOutputTokens", "routeId", "schemaVersion"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The request, exactly: these seven fields, the bounds restated as they are (never raised, never lowered to something else), or null. */
export function parseE2EModelCanaryRequest(raw: unknown): E2EModelCanaryRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== REQUEST_KEYS.join(",")) return null;
  if (record["schemaVersion"] !== E2E_MODEL_CANARY_REQUEST_SCHEMA || typeof record["canaryId"] !== "string" || !UUID.test(record["canaryId"])
    || typeof record["routeId"] !== "string" || !/^[a-z0-9][a-z0-9/._-]{0,79}$/.test(record["routeId"])
    || typeof record["definitionDigest"] !== "string" || !/^[a-f0-9]{64}$/.test(record["definitionDigest"])
    || record["maxCalls"] !== E2E_MODEL_CANARY_BOUNDS.maxCalls || record["maxInputTokens"] !== E2E_MODEL_CANARY_BOUNDS.maxInputTokens
    || record["maxOutputTokens"] !== E2E_MODEL_CANARY_BOUNDS.maxOutputTokens) return null;
  return record as unknown as E2EModelCanaryRequest;
}

export type E2EModelCanaryRefusal = "canary-request-invalid" | "agent-route-not-approved" | "model-route-changed-reapprove" | "model-environment-unsafe";
export type E2EModelCanaryResult =
  | { schemaVersion: typeof E2E_MODEL_CANARY_RESULT_SCHEMA; status: "refused"; code: E2EModelCanaryRefusal; canaryId: string | null }
  | {
    schemaVersion: typeof E2E_MODEL_CANARY_RESULT_SCHEMA; status: "called"; canaryId: string; routeId: string; routeRevision: string; definitionDigest: string;
    provider: string; modelId: string; calls: 1; receipt: E2EModelReceipt; providerPayloadSha256: string | null; usageMissing: boolean;
  };

export interface E2EModelCanaryDependencies {
  /** The worker's environment. Defaults to the process environment. */
  environment?: NodeJS.ProcessEnv;
  /** The provider call; a test seam. Production builds the real one from the route. */
  invoke?: E2EInvoke;
  now?: () => number;
  /** Test seam for the shared AWS files check. */
  assertSharedConfig?: () => void;
}

/** A budget of exactly one call within the canary's input bound: a second reserve, or one above the bound, is refused. */
function oneCallBudget(): E2EDayBudget {
  let used = false;
  return {
    reserve(inputTokens) {
      if (used || inputTokens > E2E_MODEL_CANARY_BOUNDS.maxInputTokens) return null;
      used = true;
      return { settle: () => undefined, release: () => undefined };
    },
  };
}

export async function runE2EModelCanary(raw: unknown, dependencies: E2EModelCanaryDependencies = {}): Promise<E2EModelCanaryResult> {
  const refuse = (code: E2EModelCanaryRefusal, canaryId: string | null = null): E2EModelCanaryResult => ({ schemaVersion: E2E_MODEL_CANARY_RESULT_SCHEMA, status: "refused", code, canaryId });
  const request = parseE2EModelCanaryRequest(raw);
  if (request === null) return refuse("canary-request-invalid");
  const environment = dependencies.environment ?? process.env;
  const derived = deriveE2EAgentRoute(e2eAgentInstallationFromEnvironment(environment), 1);
  if (derived.status === "unavailable") return refuse("agent-route-not-approved", request.canaryId);
  const definition = derived.definition;
  const definitionDigest = e2eAgentRouteDefinitionDigest(definition);
  if (definition.routeId !== request.routeId || definitionDigest !== request.definitionDigest) return refuse("model-route-changed-reapprove", request.canaryId);
  try {
    assertE2EEnvironmentCannotRedirect(environment);
    (dependencies.assertSharedConfig ?? (() => assertE2ESharedAwsConfigCannotRedirect()))();
  } catch {
    return refuse("model-environment-unsafe", request.canaryId);
  }
  const now = dependencies.now ?? Date.now;
  const invoke = dependencies.invoke ?? await createE2EProviderInvoke(definition, { environment });
  const route = createGovernedE2EModelRoute(definition, { invoke, now, dayBudget: oneCallBudget(), newReceiptId: () => `rcpt-canary-${randomUUID()}` });
  // The proxy's last scan: the provider key the invoke holds (none for Bedrock) and credential-shaped text never leave in a payload.
  const guard = createE2ECredentialGuard({ passwords: [...route.secretValues], emails: [], cookieValues: [] });
  const outcome = await route.generate(
    { schemaVersion: E2E_MODEL_CHANNEL_SCHEMA_VERSION, runId: request.canaryId, caseId: E2E_MODEL_CANARY_CASE_ID, stepIndex: 0, callIndex: 0, call: E2E_MODEL_CANARY_CALL },
    {
      deadlineAt: now() + CANARY_DEADLINE_MS,
      budgets: { maxInputTokens: E2E_MODEL_CANARY_BOUNDS.maxInputTokens, maxOutputTokens: E2E_MODEL_CANARY_BOUNDS.maxOutputTokens },
      inspectPayload: (payload) => { if (guard.containsSecret(payload)) throw new E2EPayloadRefusedError(); },
    },
  );
  return {
    schemaVersion: E2E_MODEL_CANARY_RESULT_SCHEMA, status: "called", canaryId: request.canaryId, routeId: definition.routeId, routeRevision: e2eModelRouteRevision(definition),
    definitionDigest, provider: definition.provider, modelId: definition.modelId, calls: 1, receipt: E2EModelReceiptSchema.parse(outcome.receipt),
    providerPayloadSha256: outcome.providerPayloadSha256 ?? null, usageMissing: outcome.usageMissing === true,
  };
}
