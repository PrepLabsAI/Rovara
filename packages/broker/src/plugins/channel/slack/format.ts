// What Rovara says, shaped for the chat tool. The text of an event is Rovara's own fixed words plus a task title or a status sentence from the task: it is escaped so that none of it can become a mention, a link or a channel
// reference, and cut to the length the adapter said it takes. A button carries only the exact request a card named; pressing it is a request (see `core/channel/cards.ts`), never an approval.
import type { ChannelDecision, ChannelEvent } from "@agentx/contracts";

/** The thread id this adapter reads as "no thread": a message at the top of a space (a direct message, a notice). It has the shape of a message time, so a conversation reference holds it. */
export const NO_THREAD = "0000000000.000000";
const SECTION_MAX = 3_000;

/** Text for the tool's markup: `&`, `<` and `>` are the only characters it reads as syntax; escaping them leaves no link, mention or channel reference. */
export const escapeText = (text: string): string => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/** Cuts text to `max` characters with an ellipsis; a cut never leaves half of an escape (`&am`) at the end. */
const cut = (text: string, max: number): string => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").replace(/&[a-z]{0,3}$/u, "")}…`;
};

/** What a button's value says. Short keys: the tool keeps a value to 2,000 characters. */
export interface ButtonValue { r: string; v: number; d: string; o: ChannelDecision["decision"] }
export const ACTION_PREFIX = "rovara_decide_";

/** The box that asks "What should change?" when Request changes is pressed: its callback name, and the names of its one input. */
export const CHANGES_CALLBACK = "rovara_changes";
export const CHANGES_INPUT = "rovara_changes_reason";
export const CHANGES_FIELD = "text";
/** What the box carries for itself (the tool keeps it to 3,000 characters): the request it is for, where the card is, and who opened it. */
export interface ChangesContext { r: string; v: number; d: string; t: string; s: string; h: string; u: string; w: string }

/** The box (a modal view) that asks what should change. The words typed in it come back as the reason of the request for changes. */
export function changesModal(context: ChangesContext): unknown {
  return {
    type: "modal", callback_id: CHANGES_CALLBACK, private_metadata: JSON.stringify(context),
    title: { type: "plain_text", text: "Request changes" }, submit: { type: "plain_text", text: "Send" }, close: { type: "plain_text", text: "Cancel" },
    blocks: [{
      type: "input", block_id: CHANGES_INPUT, label: { type: "plain_text", text: "What should change?" },
      element: { type: "plain_text_input", action_id: CHANGES_FIELD, multiline: true, max_length: 500 },
    }],
  };
}

const LABEL_STYLE: Partial<Record<ChannelDecision["decision"], "primary" | "danger">> = { APPROVE: "primary", REJECT: "danger" };

export interface Rendered {
  text: string;
  blocks?: unknown[];
  /** Only the named person sees it. */
  ephemeralTo?: string;
}

const OPEN_WORDS = "Open the task on the computer where Rovara runs: `rovara open`.";

const section = (text: string): unknown => ({ type: "section", text: { type: "mrkdwn", text: cut(escapeText(text), SECTION_MAX) } });

/** The message for an event, or undefined when the event says nothing to a person in this chat. */
export function renderEvent(event: ChannelEvent, maxLength: number): Rendered | undefined {
  const text = (value: string): string => cut(escapeText(value), maxLength);
  switch (event.type) {
    case "ack": return { text: "Got it." };
    case "progress": return { text: text(event.data.text), ...(event.data.onlyTo === undefined ? {} : { ephemeralTo: event.data.onlyTo }) };
    case "question": return { text: text(event.data.choices === undefined ? event.data.text : `${event.data.text}\n${event.data.choices.map((choice, index) => `${String(index + 1)}. ${choice}`).join("\n")}`) };
    case "check_report": return { text: text(`${{ passed: "Checks passed.", failed: "Checks failed.", unknown: "Checks have not finished." }[event.data.status]} ${event.data.text}`) };
    case "pr": return { text: text(`Pull request: ${event.data.title}\n${event.data.url}`) };
    // The text of a reply or notice only: this adapter declares no `edits`, so a later message under the same key is a new post. Parts and actions are not shown here (a follow-up; the core fits them to what the adapter declares).
    case "message": return { text: text(event.data.text), ...(event.data.audience?.kind === "ephemeral" ? { ephemeralTo: event.data.audience.actor.userId } : {}) };
    // A closing line is optional: everything the request said came before it.
    case "done": return event.data.text === undefined ? undefined : { text: text(event.data.text) };
    // Needs `direct`, which this adapter does not declare.
    case "direct": return undefined;
    case "error": return { text: text(event.data.text) };
    case "link_required": return { text: text(`Link your account to Rovara: ${event.data.linkUrl}`), ephemeralTo: event.data.actor.userId };
    case "approval_request": {
      // The "Open the task" button only when there is an address to open: with none, the words say where the task is opened.
      const open = event.data.taskUrl === undefined ? [] : [{ type: "button", text: { type: "plain_text", text: "Open the task" }, url: event.data.taskUrl, action_id: "rovara_open_task" }];
      const buttons = (event.data.actions ?? []).map((action) => ({
        type: "button", text: { type: "plain_text", text: cut(action.label, 70) }, action_id: `${ACTION_PREFIX}${action.decision}`,
        ...(LABEL_STYLE[action.decision] === undefined ? {} : { style: LABEL_STYLE[action.decision] }),
        value: JSON.stringify({ r: event.data.requestId, v: event.data.expectedRevision, d: event.data.artifactDigest, o: action.decision } satisfies ButtonValue),
      }));
      const elements = [...buttons, ...open];
      const where = event.data.taskUrl === undefined && !event.data.text.includes("rovara open") ? [{ type: "context", elements: [{ type: "mrkdwn", text: OPEN_WORDS }] }] : [];
      return { text: text(event.data.text), blocks: [section(event.data.text), ...(elements.length === 0 ? [] : [{ type: "actions", elements }]), ...where] };
    }
  }
}
