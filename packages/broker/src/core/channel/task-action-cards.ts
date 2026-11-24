// S1: a task's offers as the buttons of a message in the thread it was started from, in the channel contract's own neutral words (`MessageAction`): the adapter shapes them for its tool (Slack: `slackBlocksOf`). A card is public, so
// the value of a button carries only the task, the revision and digest it was shown and a layout hint: no right, no price, no text a person wrote. Code judges the press again, for whoever presses.
import { taskActionButtonId, type ActionOffer, type MessageAction } from "@agentx/contracts";

/** Offers that appear on a card for everyone in the thread. The People view is a button of its own on every card; taking over is reached from that view (it is offered only to the person who may). */
const ON_A_CARD = (offer: ActionOffer): boolean => offer.id !== "people.take-ownership";

/**
 * The buttons for a task's offers, at most `limit` (the adapter's declared count) with the task's own page last when there is an address. An offer that does not fit is left out, never a button the adapter would refuse; the page link
 * always has a place, so a person is never left without a way to act. Irreversible moves are `danger`.
 */
export function taskActionButtons(offers: readonly ActionOffer[], input: { taskId: string; taskUrl?: string | undefined; limit: number }): MessageAction[] {
  const room = Math.max(0, input.limit - (input.taskUrl === undefined ? 0 : 1));
  const buttons = offers.filter(ON_A_CARD).slice(0, room).map((offer): MessageAction => ({
    type: "button", actionId: taskActionButtonId(offer.id), label: offer.label.slice(0, 70),
    value: JSON.stringify({ t: input.taskId, r: offer.binding.revision, ...(offer.binding.digest === undefined ? {} : { d: offer.binding.digest }), ...(offer.needsDialog ? { n: 1 } : {}) }),
    ...(offer.risk === "irreversible" ? { style: "danger" as const } : offer.id === "plan.approve" ? { style: "primary" as const } : {}),
  }));
  return [...buttons, ...(input.taskUrl === undefined ? [] : [{ type: "link" as const, label: "Open the task", url: input.taskUrl, actionId: "rovara_open_task" }])];
}
