// Rovara's Slack chat and message router on the COMPANY's AI (DEC 254zzz79 (3)). Before a turn or a routing call the Slack service asks the broker how this thread's model calls are made
// (`POST /v1/service/model-access`, contracts/slack-model-access.ts; aws/slack-model-access.ts decides from the verified thread, never from anything this service sends):
//
//   install      the customer's OWN single-tenant install: the model runtime and the classifier this service always had, on the customer's own AWS account;
//   gateway      a company's workspace: a model runtime that speaks to the company's gateway with a fresh company-scoped token for every request. The company's own connected AI source pays, inside the
//                company's answers month and the combined company cap;
//   refused      anything else (the broker says unavailable, no answer, a reply that does not read): the thread is told the fixed words and NO model call is made, Rovara-paid Bedrock included.
//
// A company's thread is never answered on `install`: there is no fallback to the Bedrock runtime. A gateway refusal in the middle of a turn (no AI connected, no room, a fault) ends the turn with the fixed
// words for that refusal (`SLACK_MODEL_WORDS`); nothing the gateway or a model sent is echoed.
import { SLACK_MODEL_ACCESS_SERVICE_PATH, SLACK_MODEL_WORDS, SlackModelAccessResultSchema, type SlackModelRefusal } from "@agentx/contracts";
import { ClassifierError, createModelClassifier } from "@agentx/orchestrator/action-classifier";
import type { ActionClassifier } from "@agentx/orchestrator/action-gate";
import { createCompanyGatewayRuntime } from "@agentx/orchestrator/gateway-model";
import { createModelRequestRouter, type RequestRoute, type RequestRouter } from "@agentx/orchestrator/request-router";
import type { ServiceLog } from "./processor.js";

type GatewayModels = Awaited<ReturnType<typeof createCompanyGatewayRuntime>>;

export type TurnModels =
  | { kind: "install" }
  | { kind: "refused"; reason: SlackModelRefusal }
  | { kind: "gateway"; models: GatewayModels };

/** The fixed words for a refusal. */
export const refusalWords = (reason: SlackModelRefusal): string => SLACK_MODEL_WORDS[reason];

const MAX_ACCESS_BYTES = 16_384;

/**
 * #1586: the broker's `json()` adds its own `requestId` to every body (broker-primitives.ts), and the access result is strict, so the plain reply
 * `{"status":"install","requestId":"…"}` read as a fault and every Slack turn said the "couldn't reach" words. Only that one key, as a string, is taken off;
 * anything else unexpected still fails the strict parse.
 */
export function withoutBrokerRequestId(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "requestId")) return value;
  const { requestId, ...rest } = value as Record<string, unknown>;
  return typeof requestId === "string" ? rest : value;
}

/** What the broker said, or the refusal that stands for "it did not say" (never an exception). */
async function askAccess(options: { controlPlaneUrl: string; signedFetch: typeof fetch; signal?: AbortSignal | undefined }) {
  try {
    const response = await options.signedFetch(`${options.controlPlaneUrl.replace(/\/$/u, "")}${SLACK_MODEL_ACCESS_SERVICE_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}", ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.status === 403 || response.status === 404) return { status: "unavailable" } as const;
    if (response.status !== 200) return "fault" as const;
    const text = await response.text();
    if (text.length > MAX_ACCESS_BYTES) return "fault" as const;
    const parsed = SlackModelAccessResultSchema.safeParse(withoutBrokerRequestId(JSON.parse(text) as unknown));
    return parsed.success ? parsed.data : "fault" as const;
  } catch {
    return "fault" as const;
  }
}

/**
 * How this thread's model calls are made, for one turn or one routing call. `signedFetch` acts for the thread and member (createSignedServiceFetch). `fetch` is the gateway's transport (tests).
 * Never throws.
 */
export async function resolveTurnModels(options: { controlPlaneUrl: string; signedFetch: typeof fetch; fetch?: typeof fetch; signal?: AbortSignal | undefined; log?: ServiceLog }): Promise<TurnModels> {
  const first = await askAccess(options);
  if (first === "fault") return { kind: "refused", reason: "unavailable" };
  if (first.status === "install") return { kind: "install" };
  if (first.status === "unavailable") return { kind: "refused", reason: "notSetUp" };
  const { baseUrl, model } = first;
  let initial: string | undefined = first.token;
  try {
    const models = await createCompanyGatewayRuntime({
      baseUrl, model, ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      // The token just asked for goes with the first request; every later request asks again, and must get the SAME gateway and model (a token for anything else is refused).
      token: async () => {
        if (initial !== undefined) { const token = initial; initial = undefined; return token; }
        const next = await askAccess(options);
        if (next === "fault" || next.status !== "gateway" || next.baseUrl !== baseUrl || next.model !== model) throw new Error("model access is no longer available");
        return next.token;
      },
    });
    return { kind: "gateway", models };
  } catch (error) {
    options.log?.("model_access.runtime_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return { kind: "refused", reason: "unavailable" };
  }
}

/**
 * The words a failed turn says: the gateway's refusal when it gave one, else undefined (the turn's own error stands). A turn that ran on `install` has none.
 */
export const turnRefusalWords = (models: TurnModels): string | undefined => {
  if (models.kind === "refused") return refusalWords(models.reason);
  const reason = models.kind === "gateway" ? models.models.refusal() : undefined;
  return reason === undefined ? undefined : refusalWords(reason);
};

/** The gate's classifier for this turn: the install's own, or one on the company's gateway runtime (a turn that cannot make one asks for every change no rule settles, as ever). */
export async function classifierForTurn(models: TurnModels, install: ActionClassifier, options: { model: { provider: string; modelId: string }; timeoutMs: number }): Promise<ActionClassifier> {
  if (models.kind === "install") return install;
  const unavailable: ActionClassifier = async () => { throw new ClassifierError("the classifier is unavailable"); };
  if (models.kind !== "gateway") return unavailable;
  try {
    return await createModelClassifier({ model: models.models.model, timeoutMs: options.timeoutMs, modelRuntime: models.models.runtime });
  } catch { return unavailable; }
}

const UNAVAILABLE: RequestRoute = { kind: "unclear", outcome: "unavailable" };

/**
 * The message router for one Slack thread: asked when the text is routed. On `install` it is the install's own router; for a company it is the router on the company's gateway runtime (the same call
 * class as the chat); a company that cannot be served routes `unavailable` (the three-choice card), and no model is called.
 */
export function requestRouterFor(options: {
  resolve: () => Promise<TurnModels>;
  install: RequestRouter | undefined;
  timeoutMs: number;
}): RequestRouter {
  return async (message, signal) => {
    const models = await options.resolve();
    if (models.kind === "install") return options.install === undefined ? UNAVAILABLE : options.install(message, signal);
    if (models.kind !== "gateway") return UNAVAILABLE;
    try {
      const route = await createModelRequestRouter({ model: models.models.model, timeoutMs: options.timeoutMs, modelRuntime: models.models.runtime });
      const routed = await route(message, signal);
      // A refusal the company's gateway made (no AI connected, no room, a fault) is `unavailable`, as the hosted start box reads it, never a model that answered badly.
      return models.models.refusal() === undefined ? routed : UNAVAILABLE;
    } catch { return UNAVAILABLE; }
  };
}
