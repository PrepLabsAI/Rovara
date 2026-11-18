import { z } from "zod";
import { AgentXError, agentXError, PAYER_UNRESOLVED, TASK_TOKEN_SECONDS, REVIEWER_GRANT_SECONDS } from "@agentx/contracts";
import type { CallbackCapabilities } from "../../callbacks.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { mintTaskToken, MODEL_ACCESS_INVALID, type TaskTokenDeps } from "./token.js";
import { hasNoTask, readTaskTokenRecords, type TaskTokenRecords } from "./records.js";
import { withinTaskTokenDeadline } from "./deadline.js";
import { evalHealthTokenDescriber } from "./health.js";

export const MODEL_ACCESS_PATH = "/v1/internal/model-access";
export type ModelGateway = Omit<TaskTokenDeps, "now"> & { gatewayUrl: string };
const fixedRefusals = new Set([
  "CALLBACK_FORBIDDEN: callback capability is required", "CALLBACK_FORBIDDEN: invalid capability",
  "CALLBACK_FORBIDDEN: invalid capability signature", "CALLBACK_FORBIDDEN: capability does not allow model-access",
  "CALLBACK_FORBIDDEN: this operation has no model access", `CALLBACK_FORBIDDEN: ${PAYER_UNRESOLVED}`,
  "STALE_FENCE: callback no longer owns the workspace",
]);
const scopeSchema = z.object({
  workspaceId: z.uuid(), operationId: z.uuid(), fence: z.number().int().positive(),
  // Verification checks the action and expiry; validate their runtime types too.
  actions: z.array(z.string()).min(1), expiresAt: z.number().int(),
});
/** The capability is the only request input used. No request claim can reach the signer. */
export async function handleModelAccess(flow: TaskFlowDeps, capabilities: CallbackCapabilities, gateway: ModelGateway, request: BrokerRequest): Promise<BrokerResponse> {
  try {
    return await withinTaskTokenDeadline(async deadline => {
      const slots = new URL(request.path, "https://broker.invalid").searchParams.getAll("slot");
      if (slots.length > 1 || (slots.length === 1 && (!/^[a-z][a-z0-9_-]{0,63}$/u.test(slots[0]!) || gateway.describer.describeReviewer === undefined))) throw new Error("review slots need their own model access");
      const token = request.headers["x-agentx-callback-capability"];
      if (token === undefined || token === "") throw agentXError("CALLBACK_FORBIDDEN", "callback capability is required");
      if (token.length > 4096) throw agentXError("CALLBACK_FORBIDDEN", "invalid capability");
      const capability = capabilities.verify(token, "model-access");
      const parsed = scopeSchema.safeParse(capability);
      if (!parsed.success) throw agentXError("CALLBACK_FORBIDDEN", "invalid capability");
      const scope = { ...parsed.data, ...(slots.length === 0 ? {} : { reviewerSlot: slots[0]! }) };
      // The task path first, exactly as before #1026: a task's token mint makes no extra read. Only when the operation's workspace has no task at all, an opt-in eval health run's own preparation (L4-EVH) is described from the broker's own claim; any other refusal stays the task path's.
      let records: TaskTokenRecords | undefined;
      let health: Awaited<ReturnType<typeof evalHealthTokenDescriber>>;
      try { records = await readTaskTokenRecords(flow, scope, deadline); } catch (error) {
        if (!hasNoTask(error)) throw error;
        health = await evalHealthTokenDescriber(flow, scope, deadline);
        if (health === undefined) throw error;
      }
      const minted = await mintTaskToken({ ...gateway, ...(health === undefined ? {} : { describer: health }), now: () => (flow.now?.() ?? new Date()).getTime() }, scope, records, deadline);
      deadline.check();
      // Only these three metadata fields may be logged; never the token or a description.
      flow.log?.({ operationId: scope.operationId, iat: minted.expiresAt / 1000 - (scope.reviewerSlot === undefined ? TASK_TOKEN_SECONDS : REVIEWER_GRANT_SECONDS), exp: minted.expiresAt / 1000 });
      return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ baseUrl: gateway.gatewayUrl, apiKey: minted.token, expiresAt: minted.expiresAt }) };
    });
  } catch (error) {
    if (error instanceof AgentXError && fixedRefusals.has(error.message)) throw error;
    return { statusCode: 401, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ error: { type: "authentication_error", message: MODEL_ACCESS_INVALID } }) };
  }
}
