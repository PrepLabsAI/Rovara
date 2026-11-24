// The hosted model gateway's fixed STOPS (DEC 254zzz491): refusals that are a stop, never a retry and never a refused key. Each is the gateway's HTTP status and `error.type | code`, the plain sentence a person
// reads (the task's block reason and the setup run's failure), and a letters-only token the worker's model-call note carries. Browser-safe: nothing here imports.
//
// The sentences are plain constants so Cloud's contract-drift text rule can read them by expression. Cloud matches each sentence as a SUBSTRING of Code's text to show its fix-it card, so a sentence changes only with Cloud.
// ADDING A STOP is one constant above and one entry in GATEWAY_STOPS: model-runtime, the worker's note, the task flow's block reason and the setup run's failure all read this table.

/** No monthly AI limit is set for the company (the gateway's 403 `company_limit_not_set`). */
export const COMPANY_LIMIT_NOT_SET_MESSAGE = "No monthly AI limit is set for your company. Set one in Admin, AI and spending.";

/** Rovara AI is not confirmed for the company (the gateway's 403 `rovara_ai_not_confirmed`): choose how Rovara pays for AI. */
export const ROVARA_AI_NOT_CONFIRMED_MESSAGE = "Choose how Rovara pays for AI: confirm Rovara AI, billed to your company, up to your monthly limit, or connect your own AI key.";

/** Key: the gateway's code, which is also the setup run's `cannot` reason. */
export const GATEWAY_STOPS = {
  company_limit_not_set: { status: 403, message: COMPANY_LIMIT_NOT_SET_MESSAGE, signal: "CompanyLimitNotSet" },
  rovara_ai_not_confirmed: { status: 403, message: ROVARA_AI_NOT_CONFIRMED_MESSAGE, signal: "RovaraAiNotConfirmed" },
} as const;
export type GatewayStopCode = keyof typeof GATEWAY_STOPS;
export const GATEWAY_STOP_CODES = Object.keys(GATEWAY_STOPS) as GatewayStopCode[];

/** Whether a status is one a gateway stop comes with (only those answers' bodies are read). */
export const isGatewayStopStatus = (status: number): boolean => GATEWAY_STOP_CODES.some((entry) => GATEWAY_STOPS[entry].status === status);

/** The stop a gateway answer's `error.type | code` names, for the status it came with. Matched whole; anything else is undefined. */
export function gatewayStopOfAnswer(status: number, code: unknown): GatewayStopCode | undefined {
  return typeof code === "string" ? GATEWAY_STOP_CODES.find((entry) => entry === code && GATEWAY_STOPS[entry].status === status) : undefined;
}

/** The stop an error text is exactly: the sentence itself, or the not-allowed error that carries it (`MODEL_NOT_ALLOWED: <sentence>`). Matched whole, never by prefix or substring. */
export function gatewayStopOfText(text: unknown): GatewayStopCode | undefined {
  return typeof text === "string" ? GATEWAY_STOP_CODES.find((entry) => text === GATEWAY_STOPS[entry].message || text === `MODEL_NOT_ALLOWED: ${GATEWAY_STOPS[entry].message}`) : undefined;
}

/** The stop a worker note's token names (on its status). */
export function gatewayStopOfSignal(signal: unknown, status: unknown): GatewayStopCode | undefined {
  return GATEWAY_STOP_CODES.find((entry) => GATEWAY_STOPS[entry].signal === signal && GATEWAY_STOPS[entry].status === status);
}

/** The sentence a person reads for each stop, by code. */
export const GATEWAY_STOP_FAILURES = Object.fromEntries(GATEWAY_STOP_CODES.map((entry) => [entry, GATEWAY_STOPS[entry].message])) as Record<GatewayStopCode, string>;

/** Whether an error text is exactly the missing-limit stop (see `gatewayStopOfText`). */
export const isCompanyLimitNotSetText = (text: unknown): boolean => gatewayStopOfText(text) === "company_limit_not_set";
