// Spec 062 Phase 7c: Slack's Block Kit for the protocol's rich messages, and back. The Slack adapter renders a message
// with slackBlocksOf; Slack-built cards that still come as Block Kit are read into the neutral form with
// channelMessageOfSlackBlocks, which renders back to the same blocks.
import { TURN_DETAILS_ACTION_ID, type MessageAction, type MessagePart } from "./channel-adapter.js";
import { DETAILS_ACTION, detailsReplyBlocks } from "./slack-details.js";
import { splitTextAtLines } from "./text-chunks.js";

/** Slack section blocks hold 3,000 characters; cards keep under that. */
const SECTION_TEXT_LIMIT = 2_800;
const SLACK_SECTION_MAX = 3_000;

/** A rich message: plain text, and optionally parts (its whole rich form) and actions under them. */
export interface RichMessage {
  text: string;
  parts?: MessagePart[] | undefined;
  actions?: MessageAction[] | undefined;
}

/** Slack section blocks hold 3,000 characters; a long text is split at a line break where it can be. */
export function slackSectionTexts(text: string): string[] {
  return splitTextAtLines(text, SECTION_TEXT_LIMIT);
}

/** Slack's own action IDs for the core's, where Slack's interactivity already answers them. */
const SLACK_ACTION_IDS: Readonly<Record<string, string>> = { [TURN_DETAILS_ACTION_ID]: DETAILS_ACTION };

type Block = Record<string, unknown>;

const plain = (text: string) => ({ type: "plain_text", text });
const mrkdwn = (text: string) => ({ type: "mrkdwn", text });

function elementsOf(actions: readonly MessageAction[]): Block[] {
  return actions.flatMap((action, index): Block[] => {
    if (action.type === "button") {
      return [{ type: "button", action_id: SLACK_ACTION_IDS[action.actionId] ?? action.actionId, text: plain(action.label),
        ...(action.value === "" ? {} : { value: action.value }), ...(action.style === undefined ? {} : { style: action.style }) }];
    }
    if (action.type === "link") return [{ type: "button", action_id: action.actionId ?? `link_${index}`, text: plain(action.label), url: action.url }];
    if (action.type === "select") return [{ type: "static_select", action_id: action.actionId, placeholder: plain(action.placeholder), options: action.options.map((option) => ({ text: plain(option.label), value: option.value })) }];
    // A form's button opens the adapter's own modal; the Slack adapter takes forms from Phase 7c on.
    return [{ type: "button", action_id: action.actionId, text: plain(action.label), ...(action.value === "" ? {} : { value: action.value }) }];
  });
}

function blocksOfPart(part: MessagePart): Block[] {
  switch (part.type) {
    // A section Slack can hold goes as it is; a longer one is split.
    case "section": return (part.text.length <= SLACK_SECTION_MAX ? [part.text] : slackSectionTexts(part.text)).map((text) => ({ type: "section", text: mrkdwn(text) }));
    case "fields": return [{ type: "section", fields: part.fields.map((field) => mrkdwn(`*${field.label}*\n${field.value}`)) }];
    case "context": return [{ type: "context", elements: [mrkdwn(part.text)] }];
    case "divider": return [{ type: "divider" }];
    case "image": return [{ type: "image", image_url: part.url, alt_text: part.alt }];
    case "actions": return [{ type: "actions", elements: elementsOf(part.actions) }];
  }
}

/** A message's Block Kit, or undefined for text alone. Parts, when present, are the whole message; its text is the fallback. */
export function slackBlocksOf(message: RichMessage): Block[] | undefined {
  const { text, parts, actions } = message;
  if (parts === undefined && actions === undefined) return undefined;
  // The Details button alone keeps exactly the blocks Slack's replies have always had (spec 014 FR-024).
  const only = actions?.length === 1 ? actions[0] : undefined;
  if (parts === undefined && only?.type === "button" && only.actionId === TURN_DETAILS_ACTION_ID) return detailsReplyBlocks(text, only.value) as Block[];
  const blocks: Block[] = parts === undefined
    ? slackSectionTexts(text).map((section) => ({ type: "section", text: mrkdwn(section) }))
    : parts.flatMap(blocksOfPart);
  if (actions !== undefined && actions.length > 0) blocks.push({ type: "actions", elements: elementsOf(actions) });
  return blocks;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const textOf = (value: unknown, type: "mrkdwn" | "plain_text"): string | undefined => {
  const object = record(value);
  return object?.type === type && typeof object.text === "string" && Object.keys(object).every((key) => key === "type" || key === "text") ? object.text : undefined;
};

function actionOf(element: unknown): MessageAction | undefined {
  const button = record(element);
  if (button?.type !== "button" || typeof button.action_id !== "string") return undefined;
  const label = textOf(button.text, "plain_text");
  if (label === undefined) return undefined;
  const known = new Set(["type", "action_id", "text", "value", "style", "url"]);
  if (!Object.keys(button).every((key) => known.has(key))) return undefined;
  if (typeof button.url === "string") {
    if (button.value !== undefined || button.style !== undefined) return undefined;
    return { type: "link", label, url: button.url, actionId: button.action_id };
  }
  if (button.value !== undefined && typeof button.value !== "string") return undefined;
  if (button.style !== undefined && button.style !== "primary" && button.style !== "danger") return undefined;
  return { type: "button", actionId: button.action_id, value: button.value ?? "", label, ...(button.style === undefined ? {} : { style: button.style }) };
}

/**
 * Block Kit read as a rich message whose parts render back to the same blocks, or undefined for a block it cannot read
 * (the message then goes as text alone). Block IDs are not kept: Slack's handlers match action IDs only.
 */
export function channelMessageOfSlackBlocks(text: string, blocks: readonly unknown[]): RichMessage | undefined {
  const parts: MessagePart[] = [];
  for (const value of blocks) {
    const block = record(value);
    if (block === undefined) return undefined;
    if (block.type === "section") {
      const section = textOf(block.text, "mrkdwn");
      if (section === undefined || !Object.keys(block).every((key) => key === "type" || key === "text" || key === "block_id") || section.length > SLACK_SECTION_MAX) return undefined;
      parts.push({ type: "section", text: section });
    } else if (block.type === "context") {
      const elements = Array.isArray(block.elements) ? block.elements : [];
      const context = elements.length === 1 ? textOf(elements[0], "mrkdwn") : undefined;
      if (context === undefined || context.length > 3_000) return undefined;
      parts.push({ type: "context", text: context });
    } else if (block.type === "divider") {
      parts.push({ type: "divider" });
    } else if (block.type === "actions") {
      const elements = Array.isArray(block.elements) ? block.elements : [];
      const actions = elements.map(actionOf);
      if (actions.length === 0 || actions.some((action) => action === undefined)) return undefined;
      parts.push({ type: "actions", actions: actions as MessageAction[] });
    } else {
      return undefined;
    }
  }
  return { text, parts };
}
