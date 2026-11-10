// Design review stage: `GET /v1/internal/design-review/packet?slot=<key slot>`, the one route a design-review worker reads a reviewer's packet from (on the task flow's ports).
//
// The worker is not trusted with what it reads or with which reviewer it is. This route therefore (security S1 to S5):
//   - accepts only a callback capability whose actions include `design-review-packet`, a purpose of its own (a `model-access` capability alone is refused);
//   - serves only a live design-review operation: it exists, its fence matches, it is not over, it is the plan-check mode, and it carries the binding the broker stored when it dispatched it;
//   - looks the slot up in the STORED binding's reviewers (the merge step reads no packet; an unknown or malformed slot gets the same fixed refusal);
//   - serves the packet the broker STORED for that slot, byte for byte, after checking it hashes to the digest the binding carries (it never rebuilds one);
//   - answers the contract's delivery fields only, at most 2 MB, never cached, and refuses once the round is recorded on the task.
import { DesignReviewBindingSchema, PACKET_DELIVERY_BYTES_MAX, PacketDeliverySchema, agentXError, packetDigestOf, type DesignReviewBinding } from "@agentx/contracts";
import type { CallbackCapabilities } from "../../callbacks.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { operationKey, taskPointerKey } from "../task-flow/keys.js";
import { readTask } from "../task-flow/reads.js";
import { fromDocument, type OperationRecord, type TaskPointerRecord } from "../task-flow/records.js";
import { isTerminalStatus } from "../task-flow/results.js";
import { readSlotPacket } from "./packet-store.js";
import { bindingSlotOf } from "./slot-keys.js";

export const DESIGN_REVIEW_PACKET_PATH = "/v1/internal/design-review/packet";
const CAPABILITY_HEADER = "x-agentx-callback-capability";
const WORKSPACE_HEADER = "x-rovara-workspace";
/** The one text every refusal about the slot, the binding or the round carries: it says nothing of which check failed. */
const REFUSED = "this operation cannot read that packet";

/** The binding stored on a live design-review operation, or a refusal. */
export function storedBindingOf(operation: Pick<OperationRecord, "kind" | "workflowMode" | "designReview">): DesignReviewBinding {
  if (operation.kind !== "task" || operation.workflowMode !== "PLAN_CRITIQUE" || operation.designReview === undefined) throw agentXError("FORBIDDEN", REFUSED);
  const parsed = DesignReviewBindingSchema.safeParse(operation.designReview);
  if (!parsed.success) throw agentXError("FORBIDDEN", REFUSED);
  return parsed.data;
}

/** Whether the task already holds this round's record. A task that cannot be read counts as recorded (fail closed). */
async function roundRecorded(deps: TaskFlowDeps, operation: OperationRecord, round: number): Promise<boolean> {
  const pointer = fromDocument<TaskPointerRecord>(await deps.store.get(taskPointerKey(operation.workspaceId)));
  if (pointer === undefined) return true;
  const task = await readTask(deps, pointer.taskId);
  if (task === undefined || task.companyId !== operation.companyId) return true;
  return (task.workflow?.designReview?.rounds ?? []).some((recorded) => recorded.round === round);
}

export async function handleDesignReviewPacket(deps: TaskFlowDeps, capabilities: Pick<CallbackCapabilities, "verify">, request: BrokerRequest): Promise<BrokerResponse> {
  const token = request.headers[CAPABILITY_HEADER];
  if (token === undefined || token === "") throw agentXError("CALLBACK_FORBIDDEN", "callback capability is required");
  const claims = (() => { try { return capabilities.verify(token, "design-review-packet"); } catch { throw agentXError("CALLBACK_FORBIDDEN", "invalid callback capability"); } })();
  // The worker's own egress gateway stamps the workspace the call comes from: a capability is good only for its own workspace's worker.
  if (request.headers[WORKSPACE_HEADER] !== claims.workspaceId) throw agentXError("CALLBACK_FORBIDDEN", REFUSED);
  const operation = fromDocument<OperationRecord>(await deps.store.get(operationKey(claims.workspaceId, claims.operationId)));
  if (operation === undefined || operation.companyId !== deps.companyId) throw agentXError("CALLBACK_FORBIDDEN", REFUSED);
  if (operation.fence !== claims.fence) throw agentXError("STALE_FENCE", "callback operation binding is stale");
  if (isTerminalStatus(operation.status)) throw agentXError("STALE_FENCE", "terminal operations cannot read a packet");
  const binding = storedBindingOf(operation);
  // Reviewer slots only: the merge step is sent no packet.
  const asked = new URL(request.path, "http://local.invalid").searchParams.get("slot");
  const slot = bindingSlotOf(binding, asked);
  const reviewer = slot?.purpose === "reviewer" ? binding.reviewers.find((entry) => entry.keySlot === slot.keySlot) : undefined;
  if (reviewer === undefined) throw agentXError("FORBIDDEN", REFUSED);
  if (await roundRecorded(deps, operation, binding.round)) throw agentXError("FORBIDDEN", REFUSED);
  const stored = await readSlotPacket(deps.store, deps.companyId, operation.id, binding.round, reviewer.keySlot);
  if (stored === undefined) throw agentXError("FORBIDDEN", REFUSED);
  // What is served must be the packet the binding names: the stored text parses as the delivery contract, is the reviewer's role, and hashes to the binding's digest.
  let delivery: ReturnType<typeof PacketDeliverySchema.parse>;
  try { delivery = PacketDeliverySchema.parse(JSON.parse(stored.text)); } catch { throw agentXError("FORBIDDEN", REFUSED); }
  if (delivery.role !== reviewer.role || packetDigestOf(delivery) !== reviewer.packetDigest || Buffer.byteLength(stored.text, "utf8") > PACKET_DELIVERY_BYTES_MAX) throw agentXError("FORBIDDEN", REFUSED);
  deps.log?.({ component: "design-review", event: "design_review.packet_served", operationId: operation.id, slot: reviewer.keySlot, digest: reviewer.packetDigest });
  // The stored text is the answer, as it is: no wrapper, no request id (the worker reads it with a strict schema).
  return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: stored.text };
}
