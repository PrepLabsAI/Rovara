// Port lane L9a, K1: a `ModelGrantSource` over the broker's callback capabilities (callbacks.ts).
//
// The worker's `callbackCapability` is an HMAC-signed token for one workspace, operation and fence with a list of actions. Model access is the
// action "model-access": a dispatch that wants a worker to call models lists it in its capability (`extraActions` in task-flow/dispatch.ts).
// The models and the budget are the broker's own decision for the operation, so they come from the caller (`describe`), never from the worker.
import { agentXError } from "@agentx/contracts";
import type { CallbackCapabilities } from "../../callbacks.js";
import type { ModelGrant, ModelGrantSource } from "./types.js";

export interface CapabilityGrantOptions {
  capabilities: CallbackCapabilities;
  /** The models, budget and task of this operation, as the broker decided. Undefined: the operation is unknown or has no model access. */
  describe(operation: { workspaceId: string; operationId: string; fence: number }): Promise<Pick<ModelGrant, "routes" | "budget" | "taskId" | "projectName"> | undefined>;
  /** Whether the operation still holds its workspace at this fence. */
  holds(operation: { workspaceId: string; operationId: string; fence: number }): Promise<boolean>;
}

export function capabilityModelGrants(options: CapabilityGrantOptions): ModelGrantSource {
  return {
    async grant(capability) {
      const verified = options.capabilities.verify(capability, "model-access");
      const operation = { workspaceId: verified.workspaceId, operationId: verified.operationId, fence: verified.fence };
      if (!(await options.holds(operation))) throw agentXError("STALE_FENCE", "the operation no longer holds its workspace");
      const described = await options.describe(operation);
      if (described === undefined) throw agentXError("CALLBACK_FORBIDDEN", "this operation has no model access");
      return { ...operation, ...described };
    },
    async active(operation) {
      return operation.fence === undefined ? false : options.holds({ workspaceId: operation.workspaceId, operationId: operation.operationId, fence: operation.fence });
    },
  };
}

/** A source that grants nothing: what `rovara up` has until a task flow is wired to it. */
export const NO_MODEL_GRANTS: ModelGrantSource = {
  async grant() {
    throw agentXError("CALLBACK_FORBIDDEN", "no task flow is running on this runtime yet");
  },
  async active() {
    return false;
  },
};
