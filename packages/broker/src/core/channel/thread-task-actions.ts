// S1: the task action buttons on the cards a thread is given at its two card moments (the plan, the pull request ready), kept out of `thread-notices.ts`. Both are offered only where the thread's adapter declares `taskActions` (the host wired
// the press) AND the host serves the registry; otherwise the callers post exactly what they posted before. The buttons are the registry's offers for the task's state (public: no right, no price, no text a person wrote); each press is judged
// again, for whoever presses.
import type { ApprovalRequirement, ChannelCapabilities, MessageAction, MessagePart } from "@agentx/contracts";

type ChatChannelCapabilities = Pick<ChannelCapabilities, "buttons" | "taskActions">;
import type { TaskRecord } from "../task-flow/records.js";
import { stateOffers, type OfferCapabilities } from "../task-actions/offers.js";
import { taskActionButtons } from "./task-action-cards.js";
import { CARD_TTL_SECONDS } from "./cards.js";

const planIds = (rejects: boolean): ReadonlySet<string> => new Set(rejects ? ["plan.approve", "plan.request-changes", "plan.reject"] : ["plan.approve", "plan.request-changes"]);

/** Whether this adapter takes the registry's presses and the host serves them. */
export const takesTaskActions = (capabilities: ChatChannelCapabilities, served: OfferCapabilities | undefined): served is OfferCapabilities => capabilities.taskActions === true && served !== undefined;

/**
 * The plan card as the registry's: Approve, Request changes (and Reject where the approvers take it from the chat), judged again at each press. Undefined when the adapter or the host does not take them (the caller posts the approval card as
 * before). `deliver` sends the message; the answer is when the card stops being answerable, as `postApprovalCard` says.
 */
export async function registryPlanCard(input: {
  capabilities: ChatChannelCapabilities; served: OfferCapabilities | undefined; chatTakes: boolean; requirement: Pick<ApprovalRequirement, "rejectMethods">; chatMethod: string; task: TaskRecord; taskUrl: string | undefined; text: string; nowMs: number;
  deliver(data: { text: string; parts: MessagePart[] }): Promise<void>;
}): Promise<{ cardUntil: number } | undefined> {
  if (!input.chatTakes || !takesTaskActions(input.capabilities, input.served)) return undefined;
  const wanted = planIds(input.requirement.rejectMethods?.includes(input.chatMethod) === true);
  const offers = (await stateOffers({ plan: true }, input.task)).filter((offer) => wanted.has(offer.id));
  const actions = taskActionButtons(offers, { taskId: input.task.taskId, taskUrl: input.taskUrl, limit: input.capabilities.buttons });
  await input.deliver({ text: input.text, parts: [{ type: "section", text: input.text }, ...(actions.length === 0 ? [] : [{ type: "actions" as const, actions }])] });
  return { cardUntil: Math.floor(input.nowMs / 1000) + CARD_TTL_SECONDS };
}

/** What the task offers once its pull request is ready (merge, close, stop, ...), sent as the buttons of a follow-up message, once (`send` claims it); nothing is sent when nothing is offered. */
export async function sendRegistryNextMessage(input: {
  capabilities: ChatChannelCapabilities; served: OfferCapabilities | undefined; task: TaskRecord; taskUrl: string | undefined;
  send(deliver: () => Promise<void>): Promise<void>;
  deliver(data: { text: string; parts: MessagePart[] }): Promise<void>;
}): Promise<void> {
  if (!takesTaskActions(input.capabilities, input.served)) return;
  const offers = await stateOffers(input.served, input.task).catch(() => []);
  const actions: MessageAction[] = taskActionButtons(offers, { taskId: input.task.taskId, taskUrl: input.taskUrl, limit: input.capabilities.buttons });
  if (offers.length === 0 || actions.length === 0) return;
  const message = { text: "What next for this task:", parts: [{ type: "section" as const, text: "What next for this task:" }, { type: "actions" as const, actions }] };
  await input.send(() => input.deliver(message));
}
