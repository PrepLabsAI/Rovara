import { ClassifierError, createModelClassifier, usableClassifierTimeout } from "@agentx/orchestrator/action-classifier";
import { createGateSession, type ActionClassifier, type GateDecision } from "@agentx/orchestrator/action-gate";
import { createOrchestratorRuntime, type OrchestratorOptions } from "@agentx/orchestrator/orchestrator";
import { TURN_GATE_REASON_LIMIT, redactAndCap } from "@agentx/contracts";
import type { ServiceLog, TurnInput } from "./processor.js";

export interface HostedRuntimeOptions extends Pick<OrchestratorOptions, "stateDirectory" | "api" | "model" | "sessionFile" | "onConnectorUnavailable" | "onExtensionError" | "modelRuntime"> {
  /** Absent, every change no rule settles asks. */
  classifier?: ActionClassifier;
  /** The gate's deadline for one classifier check; the same setting as the classifier's own timeout. */
  classifierTimeoutMs?: number;
  onGateDecision?: (decision: GateDecision) => void;
}

/**
 * Shared production/test boundary: tool routing comes from workspace resolution, never Slack text.
 * Every hosted turn runs the action gate (spec 014); without a gate session it asks on behalf of the
 * message's author.
 */
export function createHostedSlackRuntime(input: TurnInput, options: HostedRuntimeOptions) {
  const { classifier, classifierTimeoutMs: gateTimeoutMs, onGateDecision, ...runtime } = options;
  return createOrchestratorRuntime({
    ...runtime,
    projectInstructions: input.orchestratorInstructions,
    replySurface: "slack",
    context: { workspaceId: input.workspaceId, conversationId: input.conversationId },
    requestId: input.requestId,
    ...(input.connectors === undefined ? {} : { connectors: input.connectors }),
    ...(input.repositories === undefined ? {} : { repositories: input.repositories }),
    ...(input.recoverableOperations === undefined ? {} : { recoverableOperations: input.recoverableOperations }),
    ...(input.worker === undefined ? {} : { worker: input.worker }),
    ...(input.recorder === undefined ? {} : { turnRecorder: input.recorder }),
    ...(input.refreshConnectors === undefined ? {} : { refreshConnectors: input.refreshConnectors }),
    ...(input.onOperationAccepted === undefined ? {} : { onOperationAccepted: input.onOperationAccepted }),
    actionGate: {
      session: input.gate ?? createGateSession(input.message.userId),
      ...(input.computePrepared === true ? { computePrepared: true } : {}),
      ...(input.actionPolicy === undefined ? {} : { policy: input.actionPolicy }),
      ...(classifier === undefined ? {} : { classifier }),
      ...(gateTimeoutMs === undefined ? {} : { classifierTimeoutMs: gateTimeoutMs }),
      ...(onGateDecision === undefined ? {} : { onDecision: onGateDecision }),
    },
  });
}

/**
 * The service's classifier, made once at startup. If it cannot be made, the service still starts,
 * logs why (the error class only) and uses a classifier that always fails, so every change no rule
 * settles asks. The classifier's prompt is never logged.
 */
export async function createHostedClassifier(options: {
  model: { provider: string; modelId: string };
  timeoutMs: number;
  log: ServiceLog;
  /** Tests register Pi's faux provider here; production creates its own. */
  modelRuntime?: Parameters<typeof createModelClassifier>[0]["modelRuntime"];
  create?: typeof createModelClassifier;
}): Promise<{ classifier: ActionClassifier; available: boolean }> {
  const create = options.create ?? createModelClassifier;
  try {
    // A model the runtime does not know is a startup failure too, so the start log says unavailable.
    return {
      classifier: await create({
        model: options.model, timeoutMs: options.timeoutMs, failOnUnknownModel: true,
        ...(options.modelRuntime === undefined ? {} : { modelRuntime: options.modelRuntime }),
      }),
      available: true,
    };
  } catch (error) {
    options.log("gate.classifier_unavailable", {
      provider: options.model.provider, model: options.model.modelId, errorName: error instanceof Error ? error.name : "unknown",
    });
    return { classifier: async () => { throw new ClassifierError("the classifier is unavailable"); }, available: false };
  }
}

/** The classifier's timeout setting: a whole number of milliseconds from 1 to 60,000, else 8 seconds. */
export function classifierTimeoutMs(value: string | undefined): number {
  const parsed = value !== undefined && /^[0-9]+$/u.test(value) ? Number.parseInt(value, 10) : Number.NaN;
  return usableClassifierTimeout(Number.isNaN(parsed) ? undefined : parsed);
}

/**
 * The fields of one `gate.decision` log line: never the call's arguments. A classifier's own reason
 * can echo an argument value (a new title, say), so it is never logged; the turn record keeps it with
 * argument values taken out. Other reasons are AgentX's or an administrator's, logged redacted and
 * capped like a turn record's.
 */
export function gateDecisionLogFields(eventId: string, decision: GateDecision): Record<string, string | number | boolean> {
  return {
    eventId, tool: decision.tool, actionClass: decision.actionClass, outcome: decision.outcome, source: decision.source,
    ...(decision.source === "classifier" ? {} : { reason: redactAndCap(decision.reason, TURN_GATE_REASON_LIMIT).text }),
    argumentsHash: decision.argumentsHash.slice(0, 16),
    ...(decision.connector === undefined ? {} : { connector: decision.connector }),
    ...(decision.kind === undefined ? {} : { kind: decision.kind }),
    ...(decision.rule === undefined ? {} : { rule: decision.rule }),
    ...(decision.classifierMs === undefined ? {} : { classifierMs: decision.classifierMs }),
    ...(decision.usage === undefined ? {} : { classifierInputTokens: decision.usage.input, classifierOutputTokens: decision.usage.output, classifierCost: decision.usage.cost }),
  };
}

/**
 * Issue 157: stops the turn's model when the processor hands the turn off, so the old task starts
 * no further tool call while the new task resumes it. Returns the function that lets go.
 */
export function stopModelOnAbort(signal: AbortSignal | undefined, runtime: { session: { abort(): Promise<void> } }): () => void {
  if (signal === undefined) return () => undefined;
  const stop = () => {
    // The task is stopping anyway; an abort that fails leaves nothing more to do.
    runtime.session.abort().catch(() => undefined);
  };
  if (signal.aborted) {
    stop();
    return () => undefined;
  }
  signal.addEventListener("abort", stop, { once: true });
  return () => signal.removeEventListener("abort", stop);
}
