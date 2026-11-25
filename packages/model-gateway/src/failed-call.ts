// A call that FAILED AFTER the request was sent (a stream that broke, a connection that dropped) is settled at what was used, never at
// the full hold. Only for a route whose provider is Bedrock on Rovara's own account (`GatewayRoute.settlesFailedCalls`): its error answers
// are already free (rovaraProviderFailure); this is the same rule for a failure that is not an HTTP error answer.
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
  const outputTokens = input.phase === "after_output" ? Math.ceil(input.outputBytes / FAILED_CALL_OUTPUT_BYTES_PER_TOKEN) : 0;
  let micros: number;
  // The hold's own arithmetic (dearest applicable input rate; tiers by size), over the estimated counts.
  try { micros = estimateCall(inputTokens, outputTokens, input.price, 0, input.plainInput, measured ? undefined : input.media); } catch { return input.reservationMicros; }
  return Math.min(input.reservationMicros, Math.max(1, micros));
}
