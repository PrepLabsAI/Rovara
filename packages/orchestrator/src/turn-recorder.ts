import { createHash } from "node:crypto";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  TURN_ARGUMENT_LIMIT,
  TURN_CALL_LIMIT,
  TURN_RECORDING_ERROR_LIMIT,
  TurnObservationSchema,
  capText,
  createTaskUsageTelemetry,
  redactArguments,
  type TaskUsageTelemetry,
  type TurnCall,
  type TurnObservation,
  type TurnOutcome,
  type UsageStats,
} from "@agentx/contracts";

interface RecordedArguments { text: string; fingerprint: string }
interface PendingCall { name: string; startedAt: number; rawArguments: unknown; recorded?: RecordedArguments; call?: TurnCall }

const OUTCOMES: Readonly<Record<string, TurnOutcome>> = {
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "FAILED",
  INTERRUPTED: "FAILED",
  UNKNOWN: "UNKNOWN",
  IN_PROGRESS: "IN_PROGRESS",
  ACCEPTED: "IN_PROGRESS",
  DISPATCHING: "IN_PROGRESS",
  RUNNING: "IN_PROGRESS",
  CANCEL_REQUESTED: "IN_PROGRESS",
};
/** The contract's own check for a worker operation id, so the recorder never keeps one the schema rejects. */
const WorkerOperationSchema = TurnObservationSchema.shape.workerOperations.element;

/**
 * Collects what one orchestrator turn was offered and chose. It keeps hashes of descriptions and the
 * manifest, redacted and capped arguments, and outcomes; never tool results, request text or response
 * text. Arguments reach a record only through redactArguments.
 */
export class TurnRecorder {
  private model: { provider: string; modelId: string } | undefined;
  private manifestHash: string | undefined;
  private offeredTools: TurnObservation["offeredTools"] = [];
  private connectorOf: ReadonlyMap<string, string> = new Map();
  private readonly pending = new Map<string, PendingCall>();
  private readonly order: string[] = [];
  private readonly errorCodes = new Map<string, string>();
  private stopReason: string | undefined;
  private emptyResponse = false;
  private usage: TaskUsageTelemetry | undefined;
  private usageError: string | undefined;
  private readonly recordingErrors = new Set<string>();
  /** Set when a new category arrived after all slots were full; the last slot then reads "overflow". */
  private recordingErrorsOverflowed = false;

  constructor(private readonly now: () => number = Date.now) {}

  offer(input: {
    manifest: string;
    tools: readonly { name: string; description: string }[];
    connectorOf: ReadonlyMap<string, string>;
    model: { provider: string; modelId: string };
  }): void {
    this.model = { provider: input.model.provider, modelId: input.model.modelId };
    this.manifestHash = sha256(input.manifest);
    this.offeredTools = input.tools.map((tool) => ({ name: tool.name, descriptionHash: sha256(tool.description) }));
    this.connectorOf = new Map(input.connectorOf);
  }

  extension(): InlineExtension {
    return {
      name: "agentx-turn-recorder",
      hidden: true,
      factory: (pi) => {
        // Each handler is guarded: a recorder failure is named in the record and never reaches Pi.
        pi.on("tool_execution_start", (event) => { this.guarded("tool_execution_start", () => { this.toolStarted(event); }); });
        pi.on("tool_execution_end", (event) => { this.guarded("tool_execution_end", () => { this.toolEnded(event); }); });
        pi.on("agent_end", (event) => { this.guarded("agent_end", () => { this.agentEnded(event.messages); }); });
      },
    };
  }

  toolStarted(event: { toolCallId: string; toolName: string; args: unknown }): void {
    if (this.pending.has(event.toolCallId)) return;
    this.pending.set(event.toolCallId, { name: event.toolName, startedAt: this.now(), rawArguments: event.args });
    this.order.push(event.toolCallId);
  }

  /** Told by the connector bridge when a call threw an AgentX error, so FORBIDDEN reads as a policy denial. */
  connectorFailed(toolCallId: string, code: string): void {
    try {
      this.errorCodes.set(toolCallId, code);
    } catch {
      this.recordingFailed("observer_failed");
    }
  }

  /**
   * Names a recording failure by a fixed category (never a raw error message); each category is
   * kept once. Past the limit, the last slot becomes "overflow" so a dropped category still shows.
   */
  recordingFailed(category: string): void {
    const name = category.slice(0, 64) || "unknown";
    if (this.recordingErrors.has(name)) return;
    if (this.recordingErrors.size >= TURN_RECORDING_ERROR_LIMIT) {
      this.recordingErrorsOverflowed = true;
      return;
    }
    this.recordingErrors.add(name);
  }

  toolEnded(event: { toolCallId: string; toolName: string; result: unknown; isError: boolean }): void {
    if (!this.pending.has(event.toolCallId)) this.toolStarted({ toolCallId: event.toolCallId, toolName: event.toolName, args: undefined });
    const pending = this.pending.get(event.toolCallId)!;
    pending.call = this.classify(event.toolCallId, pending, event);
  }

  agentEnded(messages: readonly unknown[]): void {
    const last = [...messages].reverse().find((message): message is Record<string, unknown> =>
      Boolean(message && typeof message === "object" && (message as Record<string, unknown>).role === "assistant"));
    if (!last) return;
    this.stopReason = typeof last.stopReason === "string" ? last.stopReason.slice(0, 32) : undefined;
    // An errored or aborted run is a failure, not an empty answer; emptyResponse counts the silent kind.
    const failed = this.stopReason === "error" || this.stopReason === "aborted";
    this.emptyResponse = !failed && assistantText(last.content).length === 0;
  }

  measure(before: UsageStats, after: UsageStats, outcome: "SUCCEEDED" | "FAILED"): void {
    if (!this.model) {
      this.usageError = "model was not offered";
      return;
    }
    try {
      this.usage = createTaskUsageTelemetry({
        tokens: {
          input: after.tokens.input - before.tokens.input,
          output: after.tokens.output - before.tokens.output,
          cacheRead: after.tokens.cacheRead - before.tokens.cacheRead,
          cacheWrite: after.tokens.cacheWrite - before.tokens.cacheWrite,
          total: after.tokens.total - before.tokens.total,
        },
        cost: after.cost - before.cost,
      }, this.model, outcome);
    } catch (error) {
      this.usageError = (error instanceof Error ? error.message : "usage unavailable").slice(0, 200);
    }
  }

  /** Told by the orchestrator when it could not measure usage, as a fixed category, so the record says why it has none. */
  usageFailed(reason: string): void {
    this.usageError = reason.slice(0, 200);
  }

  private guarded(event: string, run: () => void): void {
    try {
      run();
    } catch {
      this.recordingFailed(`handler_failed:${event}`);
    }
  }

  firstToolCall(): { name: string; arguments: unknown } | undefined {
    const id = this.order[0];
    const first = id === undefined ? undefined : this.pending.get(id);
    return first && { name: first.name, arguments: first.rawArguments };
  }

  observation(): TurnObservation {
    const all = this.order.map((id) => {
      const pending = this.pending.get(id)!;
      return pending.call ?? this.unfinished(pending);
    });
    const workerOperations = [...new Set(all.flatMap((call) => call.operationId !== undefined && WorkerOperationSchema.safeParse(call.operationId).success ? [call.operationId] : []))];
    return {
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.manifestHash === undefined ? {} : { manifestHash: this.manifestHash }),
      offeredTools: this.offeredTools,
      calls: all.slice(0, TURN_CALL_LIMIT),
      ...(all.length > TURN_CALL_LIMIT ? { callsTruncated: true } : {}),
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
      emptyResponse: this.emptyResponse,
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      ...(this.usageError === undefined ? {} : { usageError: this.usageError }),
      ...(this.recordingErrors.size === 0 ? {} : {
        recordingErrors: this.recordingErrorsOverflowed
          ? [...[...this.recordingErrors].slice(0, TURN_RECORDING_ERROR_LIMIT - 1), "overflow"]
          : [...this.recordingErrors],
      }),
      workerOperations: workerOperations.slice(0, TURN_CALL_LIMIT),
    };
  }

  private base(pending: PendingCall): Omit<TurnCall, "validation" | "outcome"> {
    const connector = this.connectorOf.get(pending.name);
    const recorded = this.recordArguments(pending);
    return {
      name: pending.name.slice(0, 128) || "[empty]",
      ...(connector === undefined ? {} : { connector }),
      arguments: recorded.text,
      argumentsFingerprint: recorded.fingerprint,
      durationMs: Math.max(0, this.now() - pending.startedAt),
    };
  }

  /** Redacted once per call: the capped text for the record, and a fingerprint of the whole redacted form. */
  private recordArguments(pending: PendingCall): RecordedArguments {
    if (pending.recorded === undefined) {
      const full = redactArguments(pending.rawArguments ?? {}, Number.POSITIVE_INFINITY);
      pending.recorded = { text: capText(full, TURN_ARGUMENT_LIMIT).text, fingerprint: sha256(full).slice(0, 32) };
    }
    return pending.recorded;
  }

  private unfinished(pending: PendingCall): TurnCall {
    return { ...this.base(pending), validation: "ok", outcome: "IN_PROGRESS" };
  }

  private classify(toolCallId: string, pending: PendingCall, event: { result: unknown; isError: boolean }): TurnCall {
    const base = this.base(pending);
    const text = resultText(event.result);
    if (event.isError) {
      if (text.startsWith(`Tool ${pending.name} not found`)) return { ...base, validation: "unknown_tool", outcome: "FAILED" };
      if (text.startsWith("Validation failed for tool")) return { ...base, validation: "schema_error", outcome: "FAILED" };
      const code = this.errorCodes.get(toolCallId);
      return { ...base, validation: code === "FORBIDDEN" ? "policy_denied" : "ok", outcome: "FAILED", ...(code === undefined ? {} : { reason: code.slice(0, 64) }) };
    }
    const parsed = parseObject(text);
    const status = typeof parsed.status === "string" ? parsed.status : undefined;
    const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 64) : undefined;
    const requestId = base.connector !== undefined && typeof parsed.requestId === "string" ? parsed.requestId.slice(0, 64) : undefined;
    const operationId = typeof parsed.operationId === "string" ? parsed.operationId.slice(0, 64) : undefined;
    return {
      ...base,
      validation: reason === "policy_denied" ? "policy_denied" : "ok",
      outcome: status === undefined ? "SUCCEEDED" : Object.hasOwn(OUTCOMES, status) ? OUTCOMES[status]! : "FAILED",
      ...(reason === undefined ? {} : { reason }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(operationId === undefined ? {} : { operationId }),
    };
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function resultText(result: unknown): string {
  const content = result && typeof result === "object" ? (result as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text"
    && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []).join("\n");
}

function assistantText(content: unknown): string {
  return resultText({ content }).replace(/<thinking>[\s\S]*?<\/thinking>\s*/giu, "").trim();
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
