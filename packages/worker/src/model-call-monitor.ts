import { MODEL_PROVIDERS, type E2EModelFailureClass, type ModelProvider } from "@agentx/contracts";
import { classifyProviderFailure } from "@agentx/model-runtime";
import type { WorkerLogSink } from "./worker-log.js";

/**
 * Model-call primitives for the worker (PLANINC-3a), all pure or driven by an injected clock:
 *  - `sanitizeModelCallEvent` turns a Pi session event into a fixed-shape note that carries no provider text, prompt, reasoning or credential;
 *  - `ModelCallMonitor` counts attempts, sends a numbers-only heartbeat while a model call is in flight, and trips a wall-clock deadline or a no-activity stall once.
 * The wiring into a task run (subscribe, abort, flush order, the operation error) is PLANINC-3b.
 *
 * Every string in a note is one of: a fixed word from this file, a provider name from MODEL_PROVIDERS, an allow-listed error token (`classifyProviderFailure`),
 * or a request id that is plain letters, digits and hyphens. Anything else is dropped, not cleaned.
 */

/** A request id as Bedrock and the keyed providers print it. Anything longer or with other characters is not kept. */
export const MODEL_REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export type ModelCallNote =
  | { outcome: "failed"; class: E2EModelFailureClass; signal: string | null; attempt: number; provider?: ModelProvider; requestId?: string; durationMs?: number; status?: number }
  | { outcome: "stopped"; attempt: number; provider?: ModelProvider; durationMs?: number }
  /** Pi scheduled retry `attempt` of `maxAttempts` (both are retries, not model calls) after `delayMs`. */
  | { outcome: "retrying"; attempt: number; maxAttempts: number; delayMs: number }
  /** Pi's retries ended: `success` says whether the retried call worked. `cancelled` is set when a cancel or the planning deadline ended a retry wait (Pi's own "Retry cancelled"). */
  | { outcome: "retry-finished"; success: boolean; attempt: number; cancelled?: true }
  /** `durationMs` is the time since the run's clock started. `deadline` is the wall-clock limit, `stalled` the no-activity bound. */
  | { outcome: "deadline" | "stalled"; limitMs: number; durationMs: number; attempt: number };

export type ModelCallExpiry = "deadline" | "stall";

export interface ModelCallNotePayload { modelCall: ModelCallNote }

export interface HeartbeatNote {
  phase: "model";
  attempt: number;
  elapsedMs: number;
  sinceActivityMs: number;
}

export interface HeartbeatPayload { heartbeat: HeartbeatNote }

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const wholeNumber = (value: unknown, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : undefined;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPT = 1_000;

function providerOf(value: unknown): ModelProvider | undefined {
  return typeof value === "string" && (MODEL_PROVIDERS as readonly string[]).includes(value) ? (value as ModelProvider) : undefined;
}

/** The first diagnostic that names a Bedrock-style error code, status or request id: only its tokens are read. */
function failureFacts(message: Record<string, unknown>): { signal?: string; status?: number; requestId?: string } {
  const found: { signal?: string; status?: number; requestId?: string } = {};
  const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics.slice(0, 8) : [];
  for (const diagnostic of diagnostics) {
    const details = isRecord(diagnostic) && isRecord(diagnostic.details) ? diagnostic.details : undefined;
    if (details === undefined) continue;
    if (found.signal === undefined && typeof details.errorCode === "string") found.signal = details.errorCode;
    const status = wholeNumber(details.status, 599);
    if (found.status === undefined && status !== undefined && status >= 100) found.status = status;
    if (found.requestId === undefined && typeof details.requestId === "string" && MODEL_REQUEST_ID_PATTERN.test(details.requestId)) found.requestId = details.requestId;
  }
  return found;
}

/** Pi's fixed final error when an abort lands in a retry wait. Compared, never copied. */
const PI_RETRY_CANCELLED = "Retry cancelled";

/**
 * What AgentX's own keyed-provider transport (packages/model-runtime `safeError`) writes after "<Label> request failed; ": one fixed sentence chosen from the HTTP status alone. Each is matched whole, and only a
 * status comes out of it: `classify` is the status the classifier decides on, `report` the status that is certain (a class of statuses has none). None of the text is copied.
 */
const TRANSPORT_DETAILS: ReadonlyMap<string, { classify: number; report?: number }> = new Map([
  ["check the API key and its permissions", { classify: 401 }],
  ["check the key's credit balance and spending limit", { classify: 402, report: 402 }],
  ["check model availability and the provider allowlist", { classify: 404, report: 404 }],
  ["check the model ID and that the key's organization can use it", { classify: 404, report: 404 }],
  ["rate limited; wait before retrying", { classify: 429, report: 429 }],
  ["rate limited or out of credits; check the key's usage limits before retrying", { classify: 429, report: 429 }],
  ["the provider is overloaded; wait before retrying", { classify: 529, report: 529 }],
  ["upstream unavailable; check provider status before retrying", { classify: 500 }],
  ["the request was refused; check the model's context and output limits", { classify: 400 }],
  ["the ChatGPT connection was refused, so connect ChatGPT again", { classify: 401 }],
  ["your ChatGPT plan's usage limit may be reached, see https://chatgpt.com/settings/usage", { classify: 429, report: 429 }],
  ["your ChatGPT plan may not allow this model", { classify: 404 }],
]);
const TRANSPORT_FAILURE = /^[A-Za-z][A-Za-z0-9 ._-]{0,30} request failed; ([^\n]{1,200})$/u;
/** A status the provider SDKs put first: "401 {json}", "402: {json}", or "OpenAI API error (401): ...". */
const LEADING_STATUS = [/^([4-5]\d\d)(?=[\s:]|$)/u, /^[A-Za-z][A-Za-z0-9 ._-]{0,40} API error \(([4-5]\d\d)\)/u];
const BODY_TOKEN = /"(?:type|code)"\s*:\s*"([a-z0-9_]{1,64})"/gu;

/**
 * What a keyed provider's failed message shows without diagnostics (only Bedrock adds them): a leading HTTP status, AgentX's own fixed transport sentence, and error tokens in a JSON body.
 * Only a status number and a token the provider's allow-list already knows come out; the text is matched, never copied, so a body or a message that echoes a prompt or a key leaves nothing behind.
 */
function keyedFacts(provider: ModelProvider, message: Record<string, unknown>): { signal?: string; status?: number; classifyStatus?: number } {
  const text = typeof message.errorMessage === "string" ? message.errorMessage.slice(0, 4_000) : "";
  const found: { signal?: string; status?: number; classifyStatus?: number } = {};
  for (const pattern of LEADING_STATUS) {
    const status = Number(pattern.exec(text)?.[1]);
    if (Number.isInteger(status)) { found.status = status; found.classifyStatus = status; break; }
  }
  if (found.status === undefined) {
    const detail = TRANSPORT_FAILURE.exec(text)?.[1];
    const known = detail === undefined ? undefined : TRANSPORT_DETAILS.get(detail);
    if (known !== undefined) { found.classifyStatus = known.classify; if (known.report !== undefined) found.status = known.report; }
  }
  for (const match of text.matchAll(BODY_TOKEN)) {
    const token = match[1]!;
    if (classifyProviderFailure({ provider, signal: token }).class !== "unknown") { found.signal = token; break; }
  }
  return found;
}

/**
 * `event` (a Pi session event) as a model-call note, or `undefined` when it is not one. `attempt` is the model call this event belongs to (1 for the first), which the
 * monitor counts. It reads only fixed fields: a `message_end`'s role, stop reason, provider, duration and diagnostic tokens, and a retry event's numbers. It never reads
 * `errorMessage`, `finalError`, message content or reasoning.
 */
export function sanitizeModelCallEvent(event: unknown, attempt = 1): ModelCallNotePayload | undefined {
  if (!isRecord(event) || typeof event.type !== "string") return undefined;
  const at = wholeNumber(attempt, MAX_ATTEMPT) ?? 1;
  if (event.type === "message_end") {
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant") return undefined;
    const provider = providerOf(message.provider);
    const durationMs = wholeNumber(message.durationMs, MAX_DURATION_MS);
    if (message.stopReason === "aborted") {
      return { modelCall: { outcome: "stopped", attempt: at, ...(provider === undefined ? {} : { provider }), ...(durationMs === undefined ? {} : { durationMs }) } };
    }
    if (message.stopReason !== "error") return undefined;
    const facts: { signal?: string; status?: number; requestId?: string; classifyStatus?: number } = failureFacts(message);
    if (provider !== undefined && provider !== "amazon-bedrock") {
      const keyed = keyedFacts(provider, message);
      if (facts.signal === undefined && keyed.signal !== undefined) facts.signal = keyed.signal;
      if (facts.status === undefined && keyed.status !== undefined) facts.status = keyed.status;
      const classifyStatus = facts.status ?? keyed.classifyStatus;
      if (classifyStatus !== undefined) facts.classifyStatus = classifyStatus;
    }
    const classifyStatus = facts.classifyStatus ?? facts.status;
    const failure = provider === undefined
      ? { class: "unknown" as const, signal: null }
      : classifyProviderFailure({ provider, signal: facts.signal, ...(classifyStatus === undefined ? {} : { status: classifyStatus }) });
    return {
      modelCall: {
        outcome: "failed", class: failure.class, signal: failure.signal, attempt: at,
        ...(provider === undefined ? {} : { provider }),
        ...(facts.requestId === undefined ? {} : { requestId: facts.requestId }),
        ...(facts.status === undefined ? {} : { status: facts.status }),
        ...(durationMs === undefined ? {} : { durationMs }),
      },
    };
  }
  if (event.type === "auto_retry_start") {
    const attemptNumber = wholeNumber(event.attempt, MAX_ATTEMPT);
    const maxAttempts = wholeNumber(event.maxAttempts, MAX_ATTEMPT);
    const delayMs = wholeNumber(event.delayMs, MAX_DURATION_MS);
    if (attemptNumber === undefined || maxAttempts === undefined || delayMs === undefined) return undefined;
    return { modelCall: { outcome: "retrying", attempt: attemptNumber, maxAttempts, delayMs } };
  }
  if (event.type === "auto_retry_end") {
    const attemptNumber = wholeNumber(event.attempt, MAX_ATTEMPT);
    if (typeof event.success !== "boolean" || attemptNumber === undefined) return undefined;
    const cancelled = !event.success && event.finalError === PI_RETRY_CANCELLED;
    return { modelCall: { outcome: "retry-finished", success: event.success, attempt: attemptNumber, ...(cancelled ? { cancelled: true as const } : {}) } };
  }
  return undefined;
}

/**
 * The fixed sentence for a failed or aborted model call, for the operation's error and the worker log. Same tokens as the note, so it never carries provider text.
 * Example: `the model call failed: provider-outage InternalServerException request 9e7ea41c-... attempt 4`.
 */
export function describeModelCallNote(note: ModelCallNote): string {
  switch (note.outcome) {
    case "failed":
      return `the model call failed: ${note.class}${note.signal === null ? "" : ` ${note.signal}`}${note.status === undefined ? "" : ` HTTP ${note.status}`}${note.requestId === undefined ? "" : ` request ${note.requestId}`} attempt ${note.attempt}`;
    case "stopped": return `the model call was stopped: attempt ${note.attempt}`;
    case "retrying": return `the model call is retried: retry ${note.attempt} of ${note.maxAttempts}`;
    case "retry-finished": return note.cancelled === true ? `the model call retry was cancelled: retry ${note.attempt}` : note.success ? `the model call succeeded after retry ${note.attempt}` : `the model call retries ended: retry ${note.attempt}`;
    case "deadline":
    case "stalled": return `the model did not finish: ${note.outcome === "stalled" ? "no activity" : "time limit"} after ${Math.round(note.durationMs / 1000)} s, attempt ${note.attempt}`;
  }
}

/** What a person should do next, from a failed call's class and status: fixed text. Used for the operation's error, beside `describeModelCallNote`. */
export function modelFailureNextAction(note: Extract<ModelCallNote, { outcome: "failed" }>): string {
  if (note.status === 402) return "add credits to the model account, then retry";
  switch (note.class) {
    case "key-rejected": return "check the model key and its permissions, then retry";
    case "limit-or-rate-limited": return "wait, then retry; if it keeps failing check the model's rate limit and credit balance";
    case "model-not-found": return "check the model setting, then retry";
    case "request-rejected": return "check the model settings, then retry";
    case "secret-unreadable": return "check the model key, then retry";
    case "not-in-catalog": return "choose a supported model, then retry";
    default: return "retry the step";
  }
}

export const MODEL_CALL_HEARTBEAT_MS = 60_000;
export const MODEL_CALL_MAX_HEARTBEATS = 60;
export const PLANNING_STALL_MS = 240_000;
export const PLANNING_DEADLINE_DEFAULT_MS = 25 * 60_000;
export const PLANNING_DEADLINE_MIN_MS = 5 * 60_000;
export const PLANNING_DEADLINE_MAX_MS = 60 * 60_000;
/** After a planning deadline or stall the worker asks Pi to abort, then waits this long for the abort to be confirmed before it gives up and ends the run as interrupted. */
export const PLANNING_ABORT_CONFIRM_MS = 30_000;
/** A cancel waits at most this long for the buffered events to be sent before the cancel result is posted, so a hung event sink cannot hang a cancel. */
export const CANCEL_FLUSH_MAX_MS = 5_000;
const DEFAULT_TICK_MS = 5_000;

/** The planning deadline: `AGENTX_PLAN_DEADLINE_MS` when it is a whole number from 5 to 60 minutes, else 25 minutes. Never throws on a bad value. */
export function planningDeadlineMs(env: { AGENTX_PLAN_DEADLINE_MS?: string | undefined } = process.env): number {
  const raw = env.AGENTX_PLAN_DEADLINE_MS;
  if (raw === undefined || !/^\d{1,9}$/.test(raw)) return PLANNING_DEADLINE_DEFAULT_MS;
  const value = Number(raw);
  return value >= PLANNING_DEADLINE_MIN_MS && value <= PLANNING_DEADLINE_MAX_MS ? value : PLANNING_DEADLINE_DEFAULT_MS;
}

export interface ModelCallExpiryInfo {
  reason: ModelCallExpiry;
  /** The limit that was hit: the deadline, or the stall bound. */
  limitMs: number;
  elapsedMs: number;
  sinceActivityMs: number;
  attempt: number;
}

export interface ModelCallMonitorOptions {
  /** Wall-clock limit from `start()`. Omit for none (IMPLEMENT and REVIEW keep no deadline in this task). */
  deadlineMs?: number;
  /** Longest a model call in flight may go without any session event. Omit for none. */
  stallMs?: number;
  heartbeatMs?: number;
  maxHeartbeats?: number;
  /** How often the clock is read. */
  tickMs?: number;
  now?: () => number;
  onHeartbeat?: (payload: HeartbeatPayload) => void;
  /** Called once, from the timer, when the deadline or the stall bound is reached. It must not throw; a throw is swallowed. */
  onExpire?: (info: ModelCallExpiryInfo) => void;
}

/**
 * One planning run's clock. `start()` begins the wall-clock deadline; `beginCall()` and `endCall()` bracket each `session.prompt` (the first prompt and a format retry
 * share the one deadline); `observe(event)` is fed every Pi session event. While a call is in flight it sends one heartbeat each `heartbeatMs` without any event
 * (numbers only, at most `maxHeartbeats`), and trips `onExpire` once when the stall bound or the deadline is reached. `stop()` clears the timer: call it in `finally`,
 * and before a cancel or loop-guard stop, which take precedence over the deadline.
 */
export class ModelCallMonitor {
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly heartbeatMs: number;
  private readonly maxHeartbeats: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
  private lastActivityAt = 0;
  private lastHeartbeatAt = 0;
  private callStartedAt = 0;
  private inFlight = false;
  private attempts = 0;
  private heartbeats = 0;
  private expiredBy: ModelCallExpiry | undefined;
  private stopped = false;

  constructor(private readonly options: ModelCallMonitorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.heartbeatMs = options.heartbeatMs ?? MODEL_CALL_HEARTBEAT_MS;
    this.maxHeartbeats = options.maxHeartbeats ?? MODEL_CALL_MAX_HEARTBEATS;
    for (const [name, value] of [["tick", this.tickMs], ["heartbeat", this.heartbeatMs]] as const) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`model call ${name} interval must be a positive whole number of milliseconds`);
    }
    for (const [name, value] of [["deadline", options.deadlineMs], ["stall", options.stallMs]] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`model call ${name} must be a positive whole number of milliseconds`);
    }
  }

  /** Which limit tripped, once one has. */
  get expired(): ModelCallExpiry | undefined { return this.expiredBy; }

  /** The model call (1 for the first) in flight or last begun; Pi's own retries inside one prompt each count as a call. */
  get attempt(): number { return Math.max(this.attempts, 1); }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.startedAt = this.lastActivityAt = this.lastHeartbeatAt = this.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.inFlight = false;
  }

  /** A prompt starts (or Pi starts the next retry's stream). */
  beginCall(): void {
    this.attempts += 1;
    this.inFlight = true;
    this.callStartedAt = this.lastActivityAt = this.lastHeartbeatAt = this.now();
  }

  endCall(): void {
    this.inFlight = false;
  }

  /**
   * Feeds one Pi session event. Any event is activity. `auto_retry_start` ends the failed call and begins the next call's backoff, so the attempt counter moves here;
   * the retried call is in flight again from that event, which keeps a hung retry under the stall bound.
   */
  observe(event: unknown): void {
    if (this.stopped) return;
    const at = this.now();
    this.lastActivityAt = at;
    this.lastHeartbeatAt = at;
    if (isRecord(event) && event.type === "auto_retry_start") {
      this.attempts = Math.max(this.attempts, 1) + 1;
      this.inFlight = true;
      this.callStartedAt = at;
    }
  }

  /** Reads the clock once. The timer calls it; tests call it with an injected `now`. */
  tick(): void {
    if (this.stopped || this.expiredBy !== undefined || this.timer === undefined) return;
    const at = this.now();
    const elapsedMs = at - this.startedAt;
    const sinceActivityMs = at - this.lastActivityAt;
    const { deadlineMs, stallMs } = this.options;
    // A stalled call and a spent deadline are both reported; when both hold, the stall is the more specific cause.
    if (this.inFlight && stallMs !== undefined && sinceActivityMs >= stallMs) return this.expire("stall", stallMs, elapsedMs, sinceActivityMs);
    if (deadlineMs !== undefined && elapsedMs >= deadlineMs) return this.expire("deadline", deadlineMs, elapsedMs, sinceActivityMs);
    if (this.inFlight && this.heartbeats < this.maxHeartbeats && at - this.lastHeartbeatAt >= this.heartbeatMs) {
      this.heartbeats += 1;
      this.lastHeartbeatAt = at;
      try {
        this.options.onHeartbeat?.({ heartbeat: { phase: "model", attempt: this.attempt, elapsedMs: Math.max(0, at - this.callStartedAt), sinceActivityMs: Math.max(0, sinceActivityMs) } });
      } catch { /* a heartbeat is informational and never stops a run */ }
    }
  }

  private expire(reason: ModelCallExpiry, limitMs: number, elapsedMs: number, sinceActivityMs: number): void {
    this.expiredBy = reason;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.options.onExpire?.({ reason, limitMs, elapsedMs: Math.max(0, elapsedMs), sinceActivityMs: Math.max(0, sinceActivityMs), attempt: this.attempt });
    } catch { /* the caller owns abort; a throw here must not escape a timer */ }
  }
}

/** The note to send when `onExpire` fires. */
export function expiryNote(info: ModelCallExpiryInfo): ModelCallNotePayload {
  return { modelCall: { outcome: info.reason === "stall" ? "stalled" : "deadline", limitMs: info.limitMs, durationMs: info.elapsedMs, attempt: info.attempt } };
}

const LOG_REFUSED_MAX = 10;

/**
 * One structured worker log line (stdout, then CloudWatch) for a model-call note. The note holds only fixed words, allow-listed tokens, a bounded request id and numbers, so the line
 * can carry all of it. It survives a refused event flush, which the task's event list does not.
 */
export function logModelCallNote(sink: WorkerLogSink, operationId: string, note: ModelCallNote): void {
  const event = {
    failed: "model.attempt_failed", stopped: "model.attempt_stopped", retrying: "model.retry_scheduled", "retry-finished": "model.retry_finished",
    deadline: "planning.deadline", stalled: "planning.stalled",
  }[note.outcome];
  writeLine(sink, note.outcome === "failed" || note.outcome === "deadline" || note.outcome === "stalled" ? "error" : "info", { event, invocationId: operationId, ...note });
}

/** A line for an event batch the control plane refused or could not take. Only the error code is named, never a message; at most `LOG_REFUSED_MAX` lines per run (the caller counts). */
export function logEventsRefused(sink: WorkerLogSink, operationId: string, error: unknown, refusedSoFar: number): void {
  if (refusedSoFar >= LOG_REFUSED_MAX) return;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  // The worker's callback client says "... failed with HTTP 409" for every refusal: only that number is read, so a stale-fence refusal (expected after a cancel) tells apart from a 5xx.
  const status = Number(/ failed with HTTP ([1-5]\d\d)$/u.exec(error instanceof Error ? error.message : "")?.[1]);
  writeLine(sink, "info", { event: "events.refused", invocationId: operationId, ...(typeof code === "string" && /^[A-Z_]{3,40}$/.test(code) ? { errorCode: code } : {}), ...(Number.isInteger(status) ? { httpStatus: status } : {}) });
}

function writeLine(sink: WorkerLogSink, level: "info" | "error", fields: Record<string, unknown>): void {
  try {
    sink(level, JSON.stringify({ component: "worker", ...fields }));
  } catch { /* logging never changes what the worker does */ }
}
