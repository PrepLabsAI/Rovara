import { TASK_BUDGET_EXCEEDED_PREFIX, RateQuoteV1Schema, RunPriceSchema, agentXError, runPriceWithBaseBand, safeRefusalWords } from "@agentx/contracts";
import { ModelBudgetExhaustedError, ModelNotAllowedError, type ModelBudgetScope } from "@agentx/model-runtime";
import type { ModelAccess } from "../model-access.js";

function usableModelAccessAddress(baseUrl: unknown, allowLocalHttp: boolean): boolean {
  let origin: URL | undefined;
  try { origin = typeof baseUrl === "string" ? new URL(baseUrl) : undefined; } catch { origin = undefined; }
  const loopback = origin !== undefined && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  return origin !== undefined && (origin.protocol === "https:" || (origin.protocol === "http:" && (allowLocalHttp || (loopback && process.env.NODE_ENV === "test"))))
    && origin.username === "" && origin.password === "" && !String(baseUrl).includes("?") && !String(baseUrl).includes("#");
}

const KEY_PATTERN = /^[^\s]{1,16384}$/u;

/** The answer from the control plane; anything else is refused without echoing it. */
export function parseModelAccess(body: unknown, fallbackBaseUrl?: string, allowLocalHttp = false): ModelAccess {
  const value = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const { baseUrl, apiKey, expiresAt } = value;
  const valid = usableModelAccessAddress(baseUrl, allowLocalHttp);
  if (typeof apiKey !== "string" || !KEY_PATTERN.test(apiKey) || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the control plane answered the model access request with something unexpected");
  }
  const address = valid ? baseUrl as string : fallbackBaseUrl;
  if (address === undefined || address === "") throw agentXError("RUNTIME_UNAVAILABLE", "model access has no usable proxy address");
  const parsed = RunPriceSchema.safeParse(value.runPrice);
  // PRICE-BANDS: the base band rides beside `runPrice` (`runPriceBaseBand`); a control plane that sends none, or one that is not inside the pooled rates, leaves the pooled price alone.
  // Task cost truth: the gateway's rate quote rides beside it (`rateQuote`) for pricing; one that does not read, or names another model than the run price's, is left out (the run price alone prices the run).
  const quote = RateQuoteV1Schema.safeParse(value.rateQuote);
  const price = parsed.success ? runPriceWithBaseBand(parsed.data, value.runPriceBaseBand) : undefined;
  const usableQuote = quote.success && (price === undefined || price.catalogModel === quote.data.model.modelId) ? quote.data : undefined;
  return { baseUrl: address, apiKey, expiresAt, ...(price === undefined ? {} : { runPrice: price }), ...(usableQuote === undefined ? {} : { rateQuote: usableQuote }) };
}

/** The budget level each refusal code of the control plane names; BUDGET_EXCEEDED is the member's or, by its message, the task's. */
const BUDGET_CODE_SCOPES: ReadonlyMap<string, ModelBudgetScope> = new Map([
  ["ORG_BUDGET_EXCEEDED", "org"], ["PROJECT_BUDGET_EXCEEDED", "project"], ["AGENT_BUDGET_EXCEEDED", "agent"], ["CHAIN_BUDGET_EXCEEDED", "chain"], ["TEST_ALLOWANCE_USED", "test"],
]);

/**
 * A 402 from the control plane is a spent budget (ruling R37): ORG_BUDGET_EXCEEDED is the organisation's, PROJECT_BUDGET_EXCEEDED the project's,
 * AGENT_BUDGET_EXCEEDED the agent's, CHAIN_BUDGET_EXCEEDED the chain's and TEST_ALLOWANCE_USED the member's testing allowance; BUDGET_EXCEEDED is the task's own when its message says so
 * (ruling R35) and the member's otherwise. An agent with no budget (AGENT_BUDGET_REQUIRED, a 409) is the agent's too. Only the code and the first words of
 * the message are read; nothing of the body is kept.
 */
function budgetScopeOf(status: number, body: RefusalBody | undefined): ModelBudgetScope | undefined {
  if (status !== 402 && status !== 409) return undefined;
  const { code, message } = body?.error ?? {};
  if (typeof code !== "string") return undefined;
  if (status === 409) return code === "AGENT_BUDGET_REQUIRED" ? "agent" : code === "CHAIN_BUDGET_REQUIRED" ? "chain" : undefined;
  if (code !== "BUDGET_EXCEEDED") return BUDGET_CODE_SCOPES.get(code);
  return typeof message === "string" && message.startsWith(TASK_BUDGET_EXCEEDED_PREFIX) ? "task" : "member";
}

/** Task 26: a 403 MODEL_NOT_ALLOWED is the control plane saying no AI source serves the step's model; its words are kept (bounded, printable). */
function notAllowedText(status: number, body: RefusalBody | undefined): string | undefined {
  if (status !== 403) return undefined;
  return body?.error?.code === "MODEL_NOT_ALLOWED" ? safeRefusalWords(body.error.message) : undefined;
}

/** The control plane's refusal, as far as it is read: its code and, for the two refusals above, its first words. */
type RefusalBody = { error?: { code?: unknown; message?: unknown } };

/** The refusal's code, when it is one of the control plane's fixed words (upper-case letters, digits and underscores); nothing else of the body is ever repeated. */
const REFUSAL_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
function refusalCodeOf(body: RefusalBody | undefined): string | undefined {
  const code = body?.error?.code;
  return typeof code === "string" && REFUSAL_CODE.test(code) ? code : undefined;
}

export async function refuseModelAccess(response: Response, requiredPriceModel: string | undefined): Promise<never> {
  // The body is read once; only its code (and, for a spent budget or a refused model, its first words) is used.
  const body = await response.json().catch(() => undefined) as RefusalBody | undefined;
  if (requiredPriceModel !== undefined && response.status === 503 && body?.error?.code === "RUNTIME_UNAVAILABLE") throw agentXError("RUNTIME_UNAVAILABLE", "AgentX does not know this model's price, so it did not start the run");
  const exhausted = budgetScopeOf(response.status, body);
  if (exhausted !== undefined) throw new ModelBudgetExhaustedError(exhausted);
  const refused = notAllowedText(response.status, body);
  if (refused !== undefined) throw new ModelNotAllowedError(refused);
  // DR-KEY-1: the status and the refusal's fixed code, so a refusal is never an unexplained failure (no message text, no ids).
  const code = refusalCodeOf(body);
  throw agentXError("RUNTIME_UNAVAILABLE", `model access request failed with HTTP ${response.status}${code === undefined ? "" : ` (${code})`}`);
}
