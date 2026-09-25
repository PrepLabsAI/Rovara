import { ClassifierError, createModelClassifier } from "@agentx/orchestrator/action-classifier";
import { createGateSession, type ActionClassifier, type GateDecision } from "@agentx/orchestrator/action-gate";
import { createOrchestratorRuntime, type OrchestratorOptions } from "@agentx/orchestrator/orchestrator";
import type { ServiceLog, TurnInput } from "./processor.js";

export interface HostedRuntimeOptions extends Pick<OrchestratorOptions, "stateDirectory" | "api" | "model" | "sessionFile" | "onConnectorUnavailable" | "modelRuntime"> {
  /** Absent, every change no rule settles asks. */
  classifier?: ActionClassifier;
  onGateDecision?: (decision: GateDecision) => void;
}

/**
 * Shared production/test boundary: tool routing comes from workspace resolution, never Slack text.
 * Every hosted turn runs the action gate (spec 014); without a gate session it asks on behalf of the
 * message's author.
 */
export function createHostedSlackRuntime(input: TurnInput, options: HostedRuntimeOptions) {
  const { classifier, onGateDecision, ...runtime } = options;
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
    actionGate: {
      session: input.gate ?? createGateSession(input.message.userId),
      ...(input.actionPolicy === undefined ? {} : { policy: input.actionPolicy }),
      ...(classifier === undefined ? {} : { classifier }),
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
  create?: typeof createModelClassifier;
}): Promise<{ classifier: ActionClassifier; available: boolean }> {
  const create = options.create ?? createModelClassifier;
  try {
    return { classifier: await create({ model: options.model, timeoutMs: options.timeoutMs }), available: true };
  } catch (error) {
    options.log("gate.classifier_unavailable", {
      provider: options.model.provider, model: options.model.modelId, errorName: error instanceof Error ? error.name : "unknown",
    });
    return { classifier: async () => { throw new ClassifierError("the classifier is unavailable"); }, available: false };
  }
}
