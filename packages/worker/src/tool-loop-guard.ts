import { agentXError, type AgentXError } from "@agentx/contracts";

/** The model is told it is looping after this many identical failing calls in a row (#127). */
export const REPEAT_WARNING_AT = 3;
/** The task stops after this many, when the warning did not change the model's approach. */
export const REPEAT_LIMIT = 5;
/** A backstop against any other runaway: tool calls one task may start. */
export const TOOL_CALL_LIMIT = 200;

export type ToolLoopAction =
  | { kind: "none" }
  | { kind: "warn"; message: string }
  | { kind: "stop"; error: AgentXError };

/**
 * Watches one task's pi events for a model repeating the same failing tool call, and for too many
 * tool calls. A call counts as a repeat when the tool, its arguments and its error all match the
 * previous failing call, ignoring digits in the error (timestamps, durations, process IDs). Any
 * successful call ends the streak, so editing and rerunning a failing test is never a loop.
 */
export class ToolLoopGuard {
  private readonly started = new Map<string, string>();
  private calls = 0;
  private streakSignature: string | undefined;
  private streak = 0;
  private warnedSignature: string | undefined;

  observe(event: unknown): ToolLoopAction {
    if (!event || typeof event !== "object") return { kind: "none" };
    const value = event as { type?: unknown; toolCallId?: unknown; toolName?: unknown; args?: unknown; isError?: unknown; result?: unknown };
    const callId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    if (value.type === "tool_execution_start") {
      this.calls += 1;
      if (callId !== undefined) this.started.set(callId, `${String(value.toolName)}\u0000${stableJson(value.args)}`);
      if (this.calls > TOOL_CALL_LIMIT) {
        return { kind: "stop", error: agentXError("OPERATION_INTERRUPTED", `the agent used more than ${TOOL_CALL_LIMIT} tool calls in one task; stopped it. Split the request into smaller tasks.`) };
      }
      return { kind: "none" };
    }
    if (value.type !== "tool_execution_end") return { kind: "none" };
    const call = callId === undefined ? undefined : this.started.get(callId);
    if (callId !== undefined) this.started.delete(callId);
    if (value.isError !== true || call === undefined) {
      this.streakSignature = undefined;
      this.streak = 0;
      return { kind: "none" };
    }
    const signature = `${call}\u0000${normalizedError(value.result)}`;
    this.streak = signature === this.streakSignature ? this.streak + 1 : 1;
    this.streakSignature = signature;
    const toolName = String(value.toolName);
    if (this.streak >= REPEAT_LIMIT) {
      return { kind: "stop", error: agentXError("OPERATION_INTERRUPTED", `the agent repeated the same failing ${toolName} call ${this.streak} times with the same error; stopped it. Rephrase the request or check the error it hit.`) };
    }
    if (this.streak === REPEAT_WARNING_AT && this.warnedSignature !== signature) {
      this.warnedSignature = signature;
      return {
        kind: "warn",
        message: `You have made the same ${toolName} call ${this.streak} times in a row and it failed with the same error each time. ` +
          "Repeating it will not help. Read the error, change the command or your approach, or report the problem. " +
          `After ${REPEAT_LIMIT} identical failures the task is stopped.`,
      };
    }
    return { kind: "none" };
  }
}

function normalizedError(result: unknown): string {
  const content = result && typeof result === "object" && "content" in result ? (result as { content?: unknown }).content : undefined;
  const text = Array.isArray(content)
    ? (content as unknown[]).map(partText).join("")
    : typeof result === "string" ? result : stableJson(result);
  return text.slice(0, 4_096).replace(/\d+/g, "#");
}

function partText(part: unknown): string {
  const text = part && typeof part === "object" && "text" in part ? (part as { text?: unknown }).text : undefined;
  return typeof text === "string" ? text : "";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
