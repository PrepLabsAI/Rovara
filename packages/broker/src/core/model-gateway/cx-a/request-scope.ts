import { z } from "zod";
import { agentXError } from "@agentx/contracts";
import type { CallbackCapabilities } from "../../../callbacks.js";
import type { BrokerRequest } from "../../../handler.js";
import type { TaskTokenDescriber } from "../token.js";

const scopeSchema = z.object({
  workspaceId: z.uuid(), operationId: z.uuid(), fence: z.number().int().positive(),
  // Verification checks the action and expiry; validate their runtime types too.
  actions: z.array(z.string()).min(1), expiresAt: z.number().int(),
});

/** The capability is the only request input used. No request claim can reach the signer. */
export function taskTokenScope(capabilities: CallbackCapabilities, describer: TaskTokenDescriber, request: BrokerRequest) {
  const slots = new URL(request.path, "https://broker.invalid").searchParams.getAll("slot");
  if (slots.length > 1 || (slots.length === 1 && (!/^[a-z][a-z0-9_-]{0,63}$/u.test(slots[0]!) || describer.describeReviewer === undefined))) throw new Error("review slots need their own model access");
  const token = request.headers["x-agentx-callback-capability"];
  if (token === undefined || token === "") throw agentXError("CALLBACK_FORBIDDEN", "callback capability is required");
  if (token.length > 4096) throw agentXError("CALLBACK_FORBIDDEN", "invalid capability");
  const capability = capabilities.verify(token, "model-access");
  const parsed = scopeSchema.safeParse(capability);
  if (!parsed.success) throw agentXError("CALLBACK_FORBIDDEN", "invalid capability");
  return { ...parsed.data, ...(slots.length === 0 ? {} : { reviewerSlot: slots[0]! }) };
}
