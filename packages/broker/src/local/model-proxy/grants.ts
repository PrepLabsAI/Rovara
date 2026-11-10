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
  /**
   * A design review's key slot: the models, ceiling and task of ONE slot of the operation's stored binding, or undefined when the operation has no such slot (the key is then refused: a design-review
   * operation never gets a key of its own). Throws the fixed refusal when the slot was already given its key.
   */
  describeSlot?(operation: { workspaceId: string; operationId: string; fence: number }, slot: string): Promise<Pick<ModelGrant, "routes" | "budget" | "taskId" | "projectName"> | undefined>;
  /** Records a slot token that was just minted (see `ModelGrantSource.slotMinted`). */
  slotMinted?(operation: { workspaceId: string; operationId: string; fence: number }, slot: string, minted: { keyId: string; expiresAt: number }): Promise<void>;
  /** Whether the operation still holds its workspace at this fence. */
  holds(operation: { workspaceId: string; operationId: string; fence: number }): Promise<boolean>;
}

export function capabilityModelGrants(options: CapabilityGrantOptions): ModelGrantSource {
  return {
    async grant(capability, slot) {
      const verified = options.capabilities.verify(capability, "model-access");
      const operation = { workspaceId: verified.workspaceId, operationId: verified.operationId, fence: verified.fence };
      if (!(await options.holds(operation))) throw agentXError("STALE_FENCE", "the operation no longer holds its workspace");
      // A request that names a slot is a design review's; one that does not is an ordinary operation's. The two never mix: a slot request on an operation with no stored binding is refused, and a design-review
      // operation's request with no slot is refused by `describe` (the operation has no key of its own).
      if (slot !== undefined) {
        const described = await options.describeSlot?.(operation, slot);
        if (described === undefined) throw agentXError("CALLBACK_FORBIDDEN", "this operation has no such model slot");
        return { ...operation, ...described, slot };
      }
      const described = await options.describe(operation);
      if (described === undefined) throw agentXError("CALLBACK_FORBIDDEN", "this operation has no model access");
      return { ...operation, ...described };
    },
    async slotMinted(grant, minted) {
      if (grant.slot === undefined || grant.fence === undefined) return;
      await options.slotMinted?.({ workspaceId: grant.workspaceId, operationId: grant.operationId, fence: grant.fence }, grant.slot, minted);
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
