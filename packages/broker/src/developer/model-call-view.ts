// PLANINC-1: how a model failure, a retry and a wait read in a task's event list. No I/O.
//
// The worker forwards Pi's raw session events (a `message_end` that ended in an error, `auto_retry_start`, `auto_retry_end`) and, from the newer worker, small sanitized progress
// payloads (`modelCall`, `heartbeat`). This file turns each into one fixed sentence. A sentence is built only from allow-listed tokens and numbers: the failure class and signal
// (the same allow-list a model check uses), the provider's request id, an attempt count, a delay and a duration. It never reads the provider's message, the model's thinking, the
// final error text, any prompt or any other free text, so none of them can reach a person through this view. Anything it cannot read as one of these shapes is not shown.
import { E2E_MODEL_FAILURE_CLASSES, E2E_MODEL_FAILURE_SIGNAL_PATTERN, MODEL_PROVIDERS, type DeveloperTaskEvent, type E2EModelFailureClass, type ModelProvider } from "@agentx/contracts";
import { classifyProviderFailure } from "@agentx/model-runtime";

type View = Pick<DeveloperTaskEvent, "kind" | "text">;

/** What a person is told about each class, and what to do next. Fixed text only. */
const CLASS_TEXT: Record<E2EModelFailureClass, { phrase: string; next: string }> = {
  "limit-or-rate-limited": { phrase: "rate or quota limit", next: "Wait a minute, or raise the model's limit." },
  "key-rejected": { phrase: "access refused", next: "Check the model access." },
  "model-not-found": { phrase: "model not found", next: "Check the model setting." },
  unreachable: { phrase: "provider unreachable", next: "Check the network, then retry the step." },
  "request-rejected": { phrase: "request refused", next: "Check the model settings." },
  "provider-outage": { phrase: "provider outage", next: "Retry the step." },
  "secret-unreadable": { phrase: "model key unreadable", next: "Check the model key." },
  "not-in-catalog": { phrase: "model not in the catalog", next: "Choose a supported model." },
  unknown: { phrase: "unknown cause", next: "Retry the step." },
};

/** A provider's request id is one short token; anything else (a sentence, markup) is not shown. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_COUNT = 99;
const MAX_DELAY_MS = 60 * 60 * 1000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const RETRY_CANCELLED = "Retry cancelled";

const record = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_COUNT ? value : undefined);
const millis = (value: unknown, max: number): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined);
const requestId = (value: unknown): string | undefined => (typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : undefined);
const providerOf = (value: unknown): ModelProvider | undefined => MODEL_PROVIDERS.find((provider) => provider === value);
const classOf = (value: unknown): E2EModelFailureClass | undefined => E2E_MODEL_FAILURE_CLASSES.find((entry) => entry === value);
const signalOf = (value: unknown): string | undefined => (typeof value === "string" && E2E_MODEL_FAILURE_SIGNAL_PATTERN.test(value) ? value : undefined);

/** 441950 -> "7m22s", 45000 -> "45s", 3 700 000 -> "1h1m". */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** 2000 -> "2 s", 1500 -> "1.5 s". */
const delay = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

const attemptOf = (attempt: number | undefined, max: number | undefined): string | undefined =>
  attempt === undefined ? undefined : max === undefined ? `attempt ${attempt}` : `attempt ${attempt} of ${max}`;

interface Failure { cls: E2EModelFailureClass; signal?: string | undefined; requestId?: string | undefined; attempt?: string | undefined; durationMs?: number | undefined }

function failureText(failure: Failure): string {
  const { phrase, next } = CLASS_TEXT[failure.cls];
  const parts = [`${phrase}${failure.signal === undefined ? "" : ` (${failure.signal})`}`];
  if (failure.requestId !== undefined) parts.push(`request ${failure.requestId}`);
  if (failure.attempt !== undefined) parts.push(failure.attempt);
  if (failure.durationMs !== undefined) parts.push(`after ${duration(failure.durationMs)}`);
  return `The model call failed: ${parts.join(", ")}. ${next}`;
}

/** The class and signal of a failure from the provider and the one error token the provider named. The signal is dropped when it is not one allow-listed token. */
function classify(provider: ModelProvider | undefined, signal: string | undefined): { cls: E2EModelFailureClass; signal?: string | undefined } {
  if (provider === undefined) return { cls: "unknown" };
  const result = classifyProviderFailure({ provider, signal });
  // A signal is shown only when it is a name this provider is known to use (its class is then not "unknown"): provider-controlled text that merely looks like a token is not shown.
  return { cls: result.class, ...(result.signal === null || result.class === "unknown" ? {} : { signal: result.signal }) };
}

/** Pi's assistant `message_end` that ended in an error or was aborted. Its diagnostics carry the provider's error type and request id; nothing else of it is read. */
function messageEnd(payload: Record<string, unknown>): View | undefined {
  const message = record(payload.message);
  if (message === undefined || message.role !== "assistant") return undefined;
  if (message.stopReason === "aborted") return { kind: "progress", text: "The model call was stopped." };
  if (message.stopReason !== "error") return undefined;
  let signal: string | undefined;
  let id: string | undefined;
  let bedrock = false;
  const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics.slice(0, 10) : [];
  for (const entry of diagnostics) {
    const diagnostic = record(entry);
    const details = record(diagnostic?.details);
    if (typeof diagnostic?.type === "string" && diagnostic.type.startsWith("bedrock_")) bedrock = true;
    if (details === undefined) continue;
    signal ??= signalOf(details.errorCode);
    id ??= requestId(details.requestId);
  }
  const provider = providerOf(message.provider) ?? (message.provider === undefined && bedrock ? "amazon-bedrock" : undefined);
  const { cls, signal: known } = classify(provider, signal);
  return { kind: "error", text: failureText({ cls, signal: known, requestId: id, durationMs: millis(message.durationMs, MAX_DURATION_MS) }) };
}

/** Pi's `auto_retry_start`: attempt, maxAttempts and delayMs are numbers; its errorMessage is not read. */
function retryStart(attempt: number | undefined, max: number | undefined, delayMs: number | undefined): View {
  const which = attemptOf(attempt, max);
  return { kind: "progress", text: `AgentX is retrying the model call${which === undefined ? "" : ` (${which})`}${delayMs === undefined ? "" : ` in ${delay(delayMs)}`}.` };
}

/** Pi's `auto_retry_end`: only success, the attempt number and whether Pi's own fixed "Retry cancelled" marker was the final error are read. */
function retryEnd(payload: Record<string, unknown>): View {
  if (payload.finalError === RETRY_CANCELLED && payload.success !== true) return { kind: "progress", text: "The model call retry was cancelled." };
  return retryFinished(payload.success === true, count(payload.attempt));
}

function retryFinished(success: boolean, attempt: number | undefined): View {
  const suffix = attempt === undefined ? "" : ` (attempt ${attempt})`;
  if (success) return { kind: "progress", text: `The model call retry succeeded${suffix}.` };
  return { kind: "progress", text: `The model call retries ran out${suffix}. The step will fail; retry it from the task.` };
}

/** The new worker's sanitized `modelCall` payload. Every field is re-checked here, so a worker (or an old row) cannot put text through it. */
function modelCall(value: unknown): View | undefined {
  const call = record(value);
  if (call === undefined) return undefined;
  const attempt = count(call.attempt);
  const max = count(call.maxAttempts);
  const which = attemptOf(attempt, max);
  const durationMs = millis(call.durationMs, MAX_DURATION_MS);
  switch (call.outcome) {
    case "failed": {
      // The class the worker named, and a signal only when this provider's own list agrees with that class.
      const derived = classify(providerOf(call.provider), signalOf(call.signal));
      const cls = classOf(call.class) ?? derived.cls;
      const known = derived.cls === cls ? derived.signal : undefined;
      return { kind: "error", text: failureText({ cls, signal: known, requestId: requestId(call.requestId), attempt: which, durationMs }) };
    }
    case "retrying":
      return retryStart(attempt, max, millis(call.delayMs, MAX_DELAY_MS));
    case "retry-finished":
      return retryFinished(call.success === true, attempt);
    case "stopped":
      return { kind: "progress", text: "The model call was stopped." };
    case "deadline":
    case "stalled": {
      const why = call.outcome === "deadline" ? "the model did not finish in time" : "the model sent nothing for too long";
      return { kind: "error", text: `Planning stopped: ${why}${which === undefined ? "" : ` (${which})`}${durationMs === undefined ? "" : `, after ${duration(durationMs)}`}. Retry planning.` };
    }
    default:
      return undefined;
  }
}

/** The new worker's sanitized `heartbeat`: a wait, in numbers. */
function heartbeat(value: unknown): View | undefined {
  const beat = record(value);
  if (beat === undefined) return undefined;
  const attempt = count(beat.attempt);
  const elapsed = millis(beat.elapsedMs, MAX_DURATION_MS);
  const quiet = millis(beat.sinceActivityMs, MAX_DURATION_MS);
  if (elapsed === undefined) return { kind: "progress", text: "Still waiting for the model." };
  return { kind: "progress", text: `Still waiting for the model${attempt === undefined ? "" : ` (attempt ${attempt})`}: ${duration(elapsed)} so far${quiet === undefined ? "" : `, nothing new for ${duration(quiet)}`}.` };
}

/** Whether a progress payload is the worker's heartbeat (a wait), which the event list keeps only the newest of. */
export const isHeartbeat = (payload: unknown): boolean => record(payload) !== undefined && "heartbeat" in (payload as Record<string, unknown>);

/**
 * The fixed-text view of a `progress` event payload when it is a model failure, a retry or a wait; undefined when it is none of these, so the caller reads it as it always did.
 * A payload that has the sanitized `modelCall` or `heartbeat` key is read only through it, and null when it cannot be read: the free text of any sibling field is never used.
 */
export function modelCallView(payload: unknown): View | null | undefined {
  const event = record(payload);
  if (event === undefined) return undefined;
  if ("modelCall" in event) return modelCall(event.modelCall) ?? null;
  if ("heartbeat" in event) return heartbeat(event.heartbeat) ?? null;
  switch (event.type) {
    case "message_end": return messageEnd(event);
    case "auto_retry_start": return retryStart(count(event.attempt), count(event.maxAttempts), millis(event.delayMs, MAX_DELAY_MS));
    case "auto_retry_end": return retryEnd(event);
    default: return undefined;
  }
}
