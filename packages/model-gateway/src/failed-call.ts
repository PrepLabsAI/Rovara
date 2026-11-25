// A call that FAILED AFTER the request was sent (a stream that broke, a connection that dropped) is settled at what was used, never at
// the full hold. For a route whose provider is Bedrock on Rovara's own account (`GatewayRoute.settlesFailedCalls`) that is every failure
// after the send: its error answers are already free (rovaraProviderFailure); this is the same rule for a failure that is not an HTTP
// error answer.
//
// A call WE cut short (`cause: "aborted"`: the client left, the deadline passed, the task ended) is settled the same way on EVERY route,
// including the company's own provider keys (DEC 254zzz521: "count only what was actually spent" covers the company's cap meter too).
// `cutCallMicros` is the one function for that. Usage the provider DID report (a complete usage read, or OpenRouter's final reported
// cost) is settled as measured by the caller before this module is asked; a stream the PROVIDER broke on the company's own key keeps
// the hold as before (only Rovara's own Bedrock settles those at use).
//
// Bedrock reports usage only at the END of a stream (ConverseStream: the last `metadata` event; InvokeModel: the last message_delta), so a
// stream that breaks first reports none. What the gateway CAN see is how far the stream got (counted where it is read, so reasoning the
// converter drops, and text it holds back, still count as output seen):
//   before_events  NO response head arrived (the connection broke before Bedrock answered): no output, no usage: FREE, like a throttle
//                  before output. Only when the provider broke it: a call WE cut short (the caller left, the deadline, the task ended)
//                  may already be billed for its input, so it is charged as before_output.
//   before_output  Bedrock's 2xx head arrived (it accepted the request and may have billed the input) but no answer content came: the
//                  INPUT estimate is charged (the request's size, images included, at the input rate), never the output hold.
//   after_output   answer content came (text, tool call or reasoning): the input estimate plus an estimate of the output seen (its bytes,
//                  at two bytes a token).
// A whole (non-streaming) answer whose 2xx head arrived is finished and billed in full by Bedrock: it keeps the hold.
// Anything the provider MEASURED (usage received) never reaches this module: it settles as before. Unmeasured, an estimate is charged
// instead of the full hold, as a never-confirmed estimate (receipt: estimated, missing_usage, neverConfirmed). Nothing revises it later:
// like the 24 h sweep's estimate, a price correction skips it. The estimate never exceeds the hold and is at least one micro-dollar
// when something is charged.
import { estimateCall, type MediaEstimate } from "./estimate.js";
import type { ResolvedPrice } from "./price.js";

/** Request bytes per input token when the real count is unknown. Typical English/code/JSON is 3.5 to 4.5; the estimate is not a bound. */
export const FAILED_CALL_INPUT_BYTES_PER_TOKEN = 4;
/** Answer bytes per output token seen on a stream that broke. Every token is at least a byte; real text is 3 to 4, so this charges about double the visible text. */
export const FAILED_CALL_OUTPUT_BYTES_PER_TOKEN = 2;
/** Bytes per output token when the answer is counted from the RAW bytes received (a reader that counts no progress): framing and escapes are in the bytes, and a token is at least a byte, so this never under-counts. */
export const FAILED_CALL_RECEIVED_BYTES_PER_TOKEN = 1;

export type FailedCallPhase = "before_events" | "before_output" | "after_output";
/** Who stopped the call: the provider's stream (or connection), WE did (abort, deadline, task ended), or something in the gateway (a scan hit, an unreadable whole answer). */
export type FailedCallCause = "provider" | "aborted" | "gateway";
/** The `reason` on every `provider_error` log line: fixed words only, never provider text. */
export type ProviderErrorReason = "not_sent" | "gateway_error" | `${"provider" | "aborted"}_${FailedCallPhase}`;

export interface StreamProgress { /** Complete stream events read. */ events: number; /** Bytes of answer content (text, tool name and input, reasoning) read. */ outputBytes: number }

/**
 * How far the call got. `answered`: Bedrock's 2xx head arrived. `progress`: the answer read so far (the transport's own count where it has
 * one: it sees reasoning and held text the collector never does). A whole (non-streaming) answer is all or nothing: any byte means it came.
 */
export function failedCallPhase(input: { streaming: boolean; answered: boolean; received: number; progress?: StreamProgress | undefined }): FailedCallPhase {
  if (!input.streaming) return input.received > 0 ? "after_output" : input.answered ? "before_output" : "before_events";
  const p = input.progress;
  if (p === undefined) return input.received > 0 ? "after_output" : input.answered ? "before_output" : "before_events";
  if (p.outputBytes > 0) return "after_output";
  // Bytes that were no readable event, or a head with nothing after it, are not "nothing": the provider did answer.
  if (p.events === 0 && input.received === 0 && !input.answered) return "before_events";
  return "before_output";
}

export function providerErrorReason(cause: FailedCallCause | "not_sent", phase: FailedCallPhase): ProviderErrorReason {
  return cause === "not_sent" ? "not_sent" : cause === "gateway" ? "gateway_error" : `${cause}_${phase}`;
}

export interface FailedCallInput {
  cause: FailedCallCause; phase: FailedCallPhase;
  /** The request's bytes counted as input text (the hold's own figure, with the bytes of images and media taken out). */
  inputBytes: number;
  /** Tokens the hold counts for inline images, and the audio/video the call carries (priced at their own rates, as the hold does). */
  fixedInputTokens?: number; media?: MediaEstimate | undefined;
  /** A non-streaming call whose 2xx head arrived: finished and billed in full, so the hold stands. */
  wholeAnswer?: boolean;
  /** The provider's own count of the prompt, when its start event reported one (positive evidence only). */
  inputTokens?: number | undefined;
  /** Answer bytes seen (zero before output). */
  outputBytes: number;
  /** Bytes per output token for `outputBytes`; absent: FAILED_CALL_OUTPUT_BYTES_PER_TOKEN. */
  outputBytesPerToken?: number;
  price: ResolvedPrice; plainInput: boolean; reservationMicros: number;
}

/**
 * What a failed, unmeasured call is charged, in micro-dollars: 0 (free), or the estimate in [1, reservation]. Never above the hold.
 * `undefined`: this is not a failure this rule settles (a gateway-side failure keeps the old rule, the hold).
 */
export function failedCallMicros(input: FailedCallInput): number | undefined {
  if (input.cause === "gateway" || input.wholeAnswer === true) return undefined;
  if (input.phase === "before_events" && input.cause === "provider") return 0;
  const measured = input.inputTokens !== undefined && Number.isSafeInteger(input.inputTokens) && input.inputTokens > 0;
  const inputTokens = measured ? input.inputTokens! : Math.ceil(input.inputBytes / FAILED_CALL_INPUT_BYTES_PER_TOKEN) + (input.fixedInputTokens ?? 0);
  const outputTokens = input.phase === "after_output" ? Math.ceil(input.outputBytes / (input.outputBytesPerToken ?? FAILED_CALL_OUTPUT_BYTES_PER_TOKEN)) : 0;
  let micros: number;
  // The hold's own arithmetic (dearest applicable input rate; tiers by size), over the estimated counts.
  try { micros = estimateCall(inputTokens, outputTokens, input.price, 0, input.plainInput, measured ? undefined : input.media); } catch { return input.reservationMicros; }
  return Math.min(input.reservationMicros, Math.max(1, micros));
}

/**
 * The ONE rule for a call that ended without a complete answer (a call cut at a task end, a client disconnect or the deadline on any
 * route; any failure after the send on Rovara's own Bedrock): what it is charged, in micro-dollars, as an ESTIMATE of use: the input
 * tokens sent (the provider's own count when it reported one, else the request's bytes) priced, plus the output streamed so far priced,
 * never above the hold and at least 1. Callers settle MEASURED usage (a complete usage read, a final reported cost) before asking.
 * `undefined`: this rule does not settle the call (a provider-broken stream on a company's own key, a gateway fault, a whole non-streaming
 * answer whose head arrived): the caller keeps the hold, marked estimated, as before.
 */
export function cutCallMicros(input: FailedCallInput & { /** The route is Bedrock on Rovara's own account (`GatewayRoute.settlesFailedCalls`). */ ownBedrock: boolean; /** The call can bill reasoning that is never streamed (`mayReasonUnseen`): not knowable, the hold stands. */ reasoningUnseen?: boolean }): number | undefined {
  if (!input.ownBedrock && (input.cause !== "aborted" || input.reasoningUnseen === true)) return undefined;
  return failedCallMicros(input);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/**
 * The ALLOW-LIST of models KNOWN not to reason ("safe to estimate"). Everything else (a new, renamed or unknown model, a `*-latest` alias,
 * gpt-5, o-series, codex, gemini 2.5 and later) is treated as able to reason: the table fails safe, never under-counts.
 */
const NON_REASONING = {
  /** Older Claude ids that do not think without a `thinking` field, by EXACT id (+ date and Bedrock version suffixes). Claude 5.x (opus, sonnet, haiku, fable) and every new id think with no field: not listed. */
  claude: /^(?:(?:[a-z]{2}\.)?anthropic\.)?claude-(?:3-(?:haiku|sonnet|opus)|3-5-(?:haiku|sonnet)|3-7-sonnet|sonnet-4|opus-4|opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5)(?:-\d{8}(?:-v\d+:\d+)?)?$/u,
  openai: /^(?:gpt-3\.5-turbo|gpt-4|gpt-4-turbo|gpt-4\.1|gpt-4\.1-mini|gpt-4\.1-nano|gpt-4\.5|gpt-4o|gpt-4o-mini|chatgpt-4o-latest)(?:-(?:preview|\d{4}(?:-\d{2}-\d{2})?|\d+k))?$/u,
  gemini: /^gemini-(?:1\.0-pro|1\.5-(?:pro|flash|flash-8b)|2\.0-(?:flash|flash-lite))(?:-(?:\d{3}|\d{2}-\d{2}|exp(?:-\d{2}-\d{2})?))?$/u,
  /** Gemini models whose thinking a budget of 0 turns off (never Pro, never an unlisted or *-latest name). */
  geminiOffable: /^gemini-2\.5-flash(?:-lite)?(?:-|$)/u,
} as const;
/**
 * Can this request make the model bill reasoning tokens that are never streamed? Decided by CODE from the model's identity and the request
 * the provider receives (its reasoning / thinking parameters), never from answer text. A cut call that may have reasoned and whose complete
 * usage was not read cannot be priced: what the provider billed for hidden reasoning is unknowable, so the hold stands.
 * FAILS SAFE: only a model on the allow-list above is "does not reason"; an unlisted model, an unreadable body or an unknown provider is true.
 * A request-side reasoning signal forces true even for a listed model (an enabled or adaptive `thinking`, a `reasoning_effort` other than
 * "none", a Gemini `thinkingConfig`); the one explicit off switch is Gemini 2.5 Flash / Flash-Lite with `thinkingBudget: 0`, and OpenRouter's
 * `reasoning.enabled: false` (set by the gateway from the reviewed tariff row, qualified live).
 */
export function mayReasonUnseen(provider: string, model: string, bytes: Uint8Array): boolean {
  let body: unknown;
  try { body = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return true; }
  if (!isRecord(body)) return true;
  const name = model.toLowerCase().replace(/^models\//u, "");
  const thinkingOn = (value: unknown): boolean => isRecord(value) ? value.type !== "disabled" : value !== undefined;
  const effortOn = body.reasoning_effort !== undefined && body.reasoning_effort !== "none";
  switch (provider) {
    case "anthropic": return !NON_REASONING.claude.test(name) || thinkingOn(body.thinking);
    case "bedrock": return !NON_REASONING.claude.test(name) || thinkingOn(body.thinking) || (isRecord(body.additionalModelRequestFields) && thinkingOn(body.additionalModelRequestFields.thinking));
    case "openrouter": return !(isRecord(body.reasoning) && body.reasoning.enabled === false);
    case "openai": return effortOn || !NON_REASONING.openai.test(name);
    case "gemini": case "vertex": {
      if (effortOn) return true;
      const config = isRecord(body.generationConfig) ? body.generationConfig : undefined;
      const thinking = config?.thinkingConfig;
      if (thinking !== undefined) return !(isRecord(thinking) && thinking.thinkingBudget === 0 && NON_REASONING.geminiOffable.test(name));
      return !NON_REASONING.gemini.test(name);
    }
    default: return true;
  }
}
