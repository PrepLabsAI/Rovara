import { bedrockProfileGeography, modelCheckClassSentence, type E2EModelFailure, type E2EModelFailureClass, type ModelProvider } from "@agentx/contracts";
import { MissingProviderSecret } from "./config.js";
import { classifyProviderFailure, isNetworkCode, signalPattern } from "./provider-failure.js";
import { foundationModelIdOf, quotaHint, type QuotaClient } from "./model-discovery.js";

/**
 * The single-call model check for the coding roles and the project models (M1.4 Task 4.10D, plan D-7). It wraps the checks init, `config set` and doctor already make (a one-token Bedrock
 * Converse call, a direct provider's lookup and small tool request, OpenRouter's catalog and small request), so that a failure carries one of the provider-neutral classes of
 * `classifyProviderFailure`, and a Bedrock throttle that persists is read against the model's quota (`quotaHint`): a quota of 0 is a limit, never "wait a minute".
 *
 * The e2e route does not use this: it has its own driving test. Nothing here keeps provider text: the result holds a class, a fixed signal word, and the caller's own error object (for the
 * caller's existing wording, in memory only); a sentence built here is made of fixed words and the model's id.
 */

/** A direct provider's or OpenRouter's check answered with a failing HTTP status: only the status is kept (the message is the check's own fixed sentence). */
export class ProviderCheckHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** The quota a persistent Bedrock throttle was read against. `tokensPerMinute` is null when the quota could not be read (denied, not found, or no quota applies to the id). */
export interface ModelCheckQuota { scope: "geographic" | "global"; code: string | null; tokensPerMinute: number | null }

export type ModelCheckResult =
  | { ok: true }
  | { ok: false; class: E2EModelFailureClass; signal: string | null; error: unknown; quota?: ModelCheckQuota };

export interface ModelCheckInput { provider: ModelProvider; modelId: string; region: string }
export interface ModelCheckDependencies {
  /** The existing check for this provider: it resolves when the model answers and throws otherwise. */
  run(): Promise<void>;
  /** Waits before the one retry of a Bedrock throttle; without it a throttle is not retried. */
  sleep?: (ms: number) => Promise<void>;
  /** Service Quotas, read only after the second throttle. Without it the quota stays unattempted (`quota` is absent from the result). */
  quotas?: QuotaClient;
  now?: () => number;
}

/** The pause before a throttled Bedrock check is tried once more (what init always did). */
export const BEDROCK_THROTTLE_RETRY_MS = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Names every JavaScript error can carry: they say nothing about the provider, so they are never a signal. */
const GENERIC_ERROR_NAMES: ReadonlySet<string> = new Set(["Error", "TypeError", "RangeError", "TimeoutError", "AbortError", "AgentXError"]);

function statusOf(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.status === "number") return error.status;
  const metadata = error.$metadata;
  return isRecord(metadata) && typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

function networkCodeOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; isRecord(current) && depth < 5; depth += 1) {
    if (typeof current.code === "string" && isNetworkCode(current.code)) return current.code;
    current = current.cause;
  }
  return undefined;
}

/** The class of a failed check, from the error's status, name and network code. Message text is read only to tell the model-not-in-catalog refusal apart, never kept. */
export function failureFromError(provider: ModelProvider, error: unknown): E2EModelFailure {
  // By name too: the error may come from another copy of this package (the CLI loads the built one).
  if (error instanceof MissingProviderSecret || (isRecord(error) && (error.name === "MissingProviderSecret" || error.name === "MissingOpenRouterSecret"))) return { class: "key-rejected", signal: "secret-unreadable" };
  if (isRecord(error) && error.code === "CONFIG_INVALID") {
    return typeof error.message === "string" && /not in the installed Pi catalog/.test(error.message) ? { class: "model-not-found", signal: "not-in-catalog" } : { class: "request-rejected", signal: null };
  }
  const name = isRecord(error) && typeof error.name === "string" && !GENERIC_ERROR_NAMES.has(error.name) && signalPattern(provider).test(error.name) ? error.name : undefined;
  const network = networkCodeOf(error);
  return classifyProviderFailure({
    provider,
    status: statusOf(error),
    ...(name === undefined ? {} : { signal: name }),
    ...(network === undefined ? {} : { networkCode: network }),
    timedOut: isRecord(error) && error.name === "TimeoutError" && network === undefined,
  });
}

/** The quota's name as Bedrock lists it, from a model id: no geography, date or version (`anthropic.claude-haiku-4-5-20251001-v1:0` is `anthropic.claude-haiku-4-5`). */
export function bedrockModelName(modelId: string): string {
  return foundationModelIdOf(modelId).replace(/-\d{8}-v\d+:\d+$/, "").replace(/-v\d+:\d+$/, "");
}

/** The route's scope for a Bedrock id: its profile's geography decides, and a bare foundation id (or anything else) has no cross-region quota to read. */
function quotaScopeOf(modelId: string): "geographic" | "global" | undefined {
  const geography = bedrockProfileGeography(modelId);
  return geography === undefined ? undefined : geography === "global" ? "global" : "geographic";
}

async function readQuota(input: ModelCheckInput, quotas: QuotaClient, now: () => number): Promise<ModelCheckQuota> {
  const scope = quotaScopeOf(input.modelId);
  if (scope === undefined) return { scope: "geographic", code: null, tokensPerMinute: null };
  const hint = await quotaHint({ modelId: input.modelId, region: input.region, modelName: bedrockModelName(input.modelId) }, { quotas, now });
  const entry = hint.find((candidate) => candidate.scope === scope);
  return entry === undefined ? { scope, code: null, tokensPerMinute: null } : { scope, code: entry.code, tokensPerMinute: entry.tokensPerMinute };
}

/**
 * Runs the check. A Bedrock throttle is tried once more after two seconds; if it persists and Service Quotas can be read, the result carries the quota. Every other failure carries
 * its class at once.
 */
export async function checkModel(input: ModelCheckInput, deps: ModelCheckDependencies): Promise<ModelCheckResult> {
  const attempt = async (): Promise<ModelCheckResult> => {
    try { await deps.run(); return { ok: true }; }
    catch (error) { return { ok: false, ...failureFromError(input.provider, error), error }; }
  };
  let result = await attempt();
  const throttled = (value: ModelCheckResult) => !value.ok && value.class === "limit-or-rate-limited" && input.provider === "amazon-bedrock" && value.signal === "ThrottlingException";
  if (throttled(result) && deps.sleep !== undefined) {
    await deps.sleep(BEDROCK_THROTTLE_RETRY_MS);
    result = await attempt();
  }
  if (!result.ok && throttled(result) && deps.quotas !== undefined) {
    let quota: ModelCheckQuota;
    try { quota = await readQuota(input, deps.quotas, deps.now ?? Date.now); }
    catch { quota = { scope: quotaScopeOf(input.modelId) ?? "geographic", code: null, tokensPerMinute: null }; }
    return { ...result, quota };
  }
  return result;
}

/**
 * What a persistent Bedrock throttle of a coding or project model says (INST-8). `quota` absent means the quota was not looked up, and today's text stands. `rerun` and `changeModel`
 * are the caller's own words for trying again and for choosing another model.
 */
export function bedrockThrottleSentence(input: { modelId: string; quota: ModelCheckQuota | undefined; rerun: string; changeModel: string }): string {
  const { modelId, quota } = input;
  const today = `Bedrock throttled the check of ${modelId}; wait a minute and ${input.rerun}`;
  if (quota === undefined) return today;
  if (quota.tokensPerMinute === null) return `${today}. Rovara could not read the quota`;
  if (quota.tokensPerMinute === 0) {
    return `Amazon Bedrock's limit for ${modelId} in this account is 0 tokens per minute (quota ${quota.code ?? "unknown"}). Request an increase in Service Quotas, or choose another model with ${input.changeModel}`;
  }
  return `Amazon Bedrock throttled the check of ${modelId}; if this repeats, check Service Quotas → Amazon Bedrock (quota ${quota.code ?? "unknown"}: ${quota.tokensPerMinute} tokens per minute)`;
}

/** One fixed sentence per class, naming the provider and the model, for a check that is stored or listed (a project's approved pair). It never quotes the provider. */
export const classSentence = (input: { provider: ModelProvider; modelId: string; class: E2EModelFailureClass }): string => modelCheckClassSentence(input);
