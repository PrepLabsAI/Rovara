// What the worker reads from a Pi session's events, shared by a coding task (run-task.ts) and an agent step
// (agent-run/run-agent-step.ts): the end of a model turn, whether it failed, and the kind of an event for the log.
import { MODEL_NOT_ENABLED_CODE, agentXError, type AgentXError, type ModelFailureCode } from "@agentx/contracts";
import { budgetExhaustedFromMarker, modelNotAllowedFromMarker } from "@agentx/model-runtime";
import { redactCredentials } from "./events.js";
import { describeModelCallNote, modelFailureNextAction, sanitizeModelCallEvent, type ModelCallNote } from "./model-call-monitor.js";

export interface AssistantOutcome {
  stopReason: string;
  errorMessage?: string;
  /** The provider that answered (Pi's own field), so a failure without a monitor's note can still be classified. */
  provider?: string;
}

/** The outcome an assistant message_end event reports, or undefined for any other event. */
export function assistantOutcome(event: unknown): AssistantOutcome | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown; provider?: unknown } };
  if (value.type !== "message_end" || value.message?.role !== "assistant" || typeof value.message.stopReason !== "string") return undefined;
  return {
    stopReason: value.message.stopReason,
    ...(typeof value.message.errorMessage === "string" ? { errorMessage: value.message.errorMessage } : {}),
    ...(typeof value.message.provider === "string" ? { provider: value.message.provider } : {}),
  };
}

/**
 * A turn whose last model call failed or was aborted is not a success. A coding task passes its model-call monitor's sanitized note of that call (`monitoring`): the error is then
 * built from that note (PLANINC-3b), so it names the failure class, the provider's error type, the request id and the call number, and carries none of the provider's text.
 * A run with no monitor (an agent step) gets the error message pi or AgentX's transport gave, which already omits prompts and keys; it is still redacted and bounded.
 * MERGE-DECISION: the budget and not-allowed markers are read first on both paths: they are fixed, and they decide the task's category.
 */
export function failedTurn(outcome: AssistantOutcome | undefined, monitoring?: { note: ModelCallNote | undefined }): Error | undefined {
  if (outcome?.stopReason === "error") {
    // A spent AI budget ends the task with its own category and words, and it can be continued once the budget is raised.
    const exhausted = budgetExhaustedFromMarker(outcome.errorMessage);
    if (exhausted !== undefined) return exhausted;
    // No AI source serves the step's model: a terminal refusal that keeps the control plane's words, not a fault to retry.
    const refused = modelNotAllowedFromMarker(outcome.errorMessage);
    if (refused !== undefined) return agentXError("MODEL_NOT_ALLOWED", refused.text);
    if (monitoring !== undefined) {
      // The next action follows from the failure class and HTTP status: fix the key, add credits, wait for a limit, or retry.
      const note = monitoring.note;
      const detail = note === undefined ? "the model call failed: unknown" : describeModelCallNote(note);
      const next = note?.outcome === "failed" ? modelFailureNextAction(note) : "retry the step";
      return withModelFailureCode(agentXError("RUNTIME_UNAVAILABLE", `${detail}; ${next}`), note);
    }
    const detail = String(redactCredentials(outcome.errorMessage ?? "no error message")).slice(0, 1_000);
    // DR-KEY-1 (B): the same classification as the monitor's (class and signal from the provider's error, never its words), so the error carries the structured code.
    const classified = sanitizeModelCallEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", ...(outcome.provider === undefined ? {} : { provider: outcome.provider }), ...(outcome.errorMessage === undefined ? {} : { errorMessage: outcome.errorMessage }) } })?.modelCall;
    return withModelFailureCode(agentXError("RUNTIME_UNAVAILABLE", `the model call failed: ${detail}`), classified);
  }
  // The caller reports it as CANCELLED when a cancellation was requested, and as FAILED otherwise.
  if (outcome?.stopReason === "aborted") return agentXError("OPERATION_INTERRUPTED", "the model call was aborted");
  return undefined;
}

export function eventType(event: unknown): "progress" | "tool_start" | "tool_end" {
  if (event && typeof event === "object" && "type" in event) {
    const type = event.type;
    if (type === "tool_execution_start") return "tool_start";
    if (type === "tool_execution_end" || type === "tool_result") return "tool_end";
  }
  return "progress";
}

/**
 * DR-KEY-1 (B): the structured code of a failed model call, carried on the error (`modelFailureCode`) to the operation's result and a reviewer's failure, so the broker never has to read the words.
 * Only a call the classifier named `key-rejected ModelNotEnabled` (the proxy's 403 for a model the account may not use) has one.
 */
function withModelFailureCode(error: AgentXError, note: ModelCallNote | undefined): AgentXError & { modelFailureCode?: ModelFailureCode } {
  if (note?.outcome === "failed" && note.class === "key-rejected" && note.signal === MODEL_NOT_ENABLED_CODE) return Object.assign(error, { modelFailureCode: MODEL_NOT_ENABLED_CODE });
  return error;
}
