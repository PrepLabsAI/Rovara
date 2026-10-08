// A Slack Web API double that refuses what Slack refuses.
// Limits are Slack's documented ones, plus the project's own brief limit on thread posts.
import { SlackPostError } from "../../packages/broker/src/aws/slack-web.js";

export const SLACK_LIMITS = {
  privateMetadata: 3000, sectionText: 3000, messageBlocks: 50, modalBlocks: 100, checkboxOptions: 10, selectOptions: 100,
  optionText: 75, optionValue: 150, buttonText: 75, buttonValue: 2000, messageText: 40000, modalTitle: 24, inputLabel: 2000,
  contextElements: 10, actionsElements: 25, plainTextInputMax: 3000,
} as const;

const SECTION_FIELDS = 10;
const SECTION_FIELD_TEXT = 2000;
const HEADER_TEXT = 150;
const ACTION_ID = 255;

type Record_ = Record<string, unknown>;
type Surface = "message" | "modal";
type Post = { channel: string; threadTs?: string; text: string; blocks?: unknown[]; ts: string };

/** What a reader sees: `<url|label>` shows as `label`, `<url>` as `url`. */
export function visibleSlackText(text: string): string {
  return text.replace(/<([^<>|]*)\|([^<>]*)>/g, "$2").replace(/<([^<>|]+)>/g, "$1");
}

const asRecord = (value: unknown): Record_ | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record_ : undefined);
const textOf = (value: unknown): string | undefined => {
  const text = asRecord(value)?.text;
  return typeof text === "string" ? text : undefined;
};

function refuse(method: string, code: string): never {
  throw new SlackPostError(code, method);
}

function validateOption(method: string, option: unknown): void {
  const record = asRecord(option);
  const text = textOf(record?.text);
  const value = record?.value;
  if (text === undefined || text.length < 1 || text.length > SLACK_LIMITS.optionText) refuse(method, "invalid_blocks");
  if (typeof value !== "string" || value.length < 1 || value.length > SLACK_LIMITS.optionValue) refuse(method, "invalid_blocks");
}

function validateOptions(method: string, element: Record_, maximum: number): void {
  const options = element.options;
  if (!Array.isArray(options) || options.length < 1 || options.length > maximum) refuse(method, "invalid_blocks");
  for (const option of options) validateOption(method, option);
}

function validateElement(method: string, element: unknown): void {
  const record = asRecord(element);
  if (record === undefined) refuse(method, "invalid_blocks");
  if (typeof record.action_id === "string" && record.action_id.length > ACTION_ID) refuse(method, "invalid_blocks");
  switch (record.type) {
    case "button": {
      const text = textOf(record.text);
      if (text === undefined || text.length < 1 || text.length > SLACK_LIMITS.buttonText) refuse(method, "invalid_blocks");
      if (record.value !== undefined && (typeof record.value !== "string" || record.value.length > SLACK_LIMITS.buttonValue)) refuse(method, "invalid_blocks");
      return;
    }
    case "checkboxes": return validateOptions(method, record, SLACK_LIMITS.checkboxOptions);
    case "static_select":
    case "multi_static_select": return validateOptions(method, record, SLACK_LIMITS.selectOptions);
    case "plain_text_input": {
      if (record.max_length !== undefined && (typeof record.max_length !== "number" || record.max_length > SLACK_LIMITS.plainTextInputMax)) refuse(method, "invalid_blocks");
      return;
    }
    default: return refuse(method, "invalid_blocks");
  }
}

function validateBlocks(method: string, blocks: unknown, limit: number, surface: Surface): void {
  if (!Array.isArray(blocks) || blocks.length > limit) refuse(method, "invalid_blocks");
  for (const entry of blocks) {
    const block = asRecord(entry);
    if (block === undefined) refuse(method, "invalid_blocks");
    switch (block.type) {
      case "section": {
        const text = textOf(block.text);
        const fields = block.fields;
        if (text === undefined && fields === undefined) refuse(method, "invalid_blocks");
        if (text !== undefined && (text.length < 1 || text.length > SLACK_LIMITS.sectionText)) refuse(method, "invalid_blocks");
        if (fields !== undefined) {
          if (!Array.isArray(fields) || fields.length > SECTION_FIELDS) refuse(method, "invalid_blocks");
          for (const field of fields) {
            const fieldText = textOf(field);
            if (fieldText === undefined || fieldText.length > SECTION_FIELD_TEXT) refuse(method, "invalid_blocks");
          }
        }
        if (block.accessory !== undefined) validateElement(method, block.accessory);
        break;
      }
      case "context": {
        const elements = block.elements;
        if (!Array.isArray(elements) || elements.length > SLACK_LIMITS.contextElements) refuse(method, "invalid_blocks");
        for (const element of elements) {
          const text = textOf(element);
          if (text !== undefined && text.length > SLACK_LIMITS.sectionText) refuse(method, "invalid_blocks");
        }
        break;
      }
      case "actions": {
        const elements = block.elements;
        if (!Array.isArray(elements) || elements.length < 1 || elements.length > SLACK_LIMITS.actionsElements) refuse(method, "invalid_blocks");
        for (const element of elements) validateElement(method, element);
        break;
      }
      case "divider": break;
      case "header": {
        const text = textOf(block.text);
        if (text === undefined || text.length > HEADER_TEXT) refuse(method, "invalid_blocks");
        break;
      }
      case "input": {
        if (surface !== "modal") refuse(method, "invalid_blocks");
        const label = textOf(block.label);
        if (label === undefined || label.length > SLACK_LIMITS.inputLabel) refuse(method, "invalid_blocks");
        validateElement(method, block.element);
        break;
      }
      default: refuse(method, "invalid_blocks");
    }
  }
}

function validateMessage(method: string, input: { text: string; blocks?: unknown[] | undefined }): void {
  if (input.text.length > SLACK_LIMITS.messageText) refuse(method, "msg_too_long");
  if (input.text.length === 0 && (input.blocks === undefined || input.blocks.length === 0)) refuse(method, "no_text");
  if (input.blocks !== undefined) validateBlocks(method, input.blocks, SLACK_LIMITS.messageBlocks, "message");
}

/**
 * How long a thread message reads, for the project's brief limit: the visible `text`, plus what its blocks show
 * (section, header and context text, section fields, button labels). A section that only repeats the fallback text
 * (or a slice of it, as a long text is split across sections) is the same words, so it is counted once.
 */
export function briefLength(input: { text: string; blocks?: unknown[] | undefined }): number {
  let length = visibleSlackText(input.text).length;
  const count = (value: string | undefined) => { if (value !== undefined) length += visibleSlackText(value).length; };
  const button = (element: unknown) => { if (asRecord(element)?.type === "button") count(textOf(asRecord(element)?.text)); };
  for (const entry of input.blocks ?? []) {
    const block = asRecord(entry);
    if (block === undefined) continue;
    if (block.type === "section") {
      const text = textOf(block.text);
      if (text !== undefined && !input.text.includes(text)) count(text);
      if (Array.isArray(block.fields)) for (const field of block.fields) count(textOf(field));
      button(block.accessory);
    } else if (block.type === "header") {
      count(textOf(block.text));
    } else if (block.type === "context" && Array.isArray(block.elements)) {
      for (const element of block.elements) count(textOf(element));
    } else if (block.type === "actions" && Array.isArray(block.elements)) {
      for (const element of block.elements) button(element);
    }
  }
  return length;
}

function hasAction(blocks: unknown[] | undefined, actionId: string): boolean {
  return (blocks ?? []).some((entry) => {
    const block = asRecord(entry);
    const listed: unknown[] = Array.isArray(block?.elements) ? block.elements : [];
    const elements = block?.accessory === undefined ? listed : [...listed, block.accessory];
    return elements.some((element) => asRecord(element)?.action_id === actionId);
  });
}

export class StrictSlackWeb {
  briefLimit: number | undefined;
  readonly posts: Post[] = [];
  readonly updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  readonly ephemerals: Array<{ channel: string; threadTs?: string; user: string; text: string; blocks?: unknown[] }> = [];
  readonly views: Array<{ triggerId: string; view: Record<string, unknown> }> = [];
  readonly responses: Array<{ url: string; text: string }> = [];
  private readonly failures = new Map<string, string[]>();
  private clock = 1_695_500_000_000_100;

  constructor(options: { briefLimit?: number } = {}) {
    this.briefLimit = options.briefLimit;
  }

  /** A task thread's message (posted, edited or private) reads no longer than the brief limit, when one is set. */
  private enforceBrief(method: string, input: { text: string; blocks?: unknown[] | undefined }): void {
    if (this.briefLimit !== undefined && briefLength(input) > this.briefLimit) refuse(method, "agentx_brief_limit");
  }

  /** The next call to `method` (a Web API method name such as chat.postMessage) fails with `code`. */
  failNext(method: string, code: string): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), code]);
  }

  private consumeFailure(method: string): void {
    const queued = this.failures.get(method);
    const code = queued?.shift();
    if (code !== undefined) refuse(method, code);
  }

  post(input: { channel: string; threadTs?: string; text: string; blocks?: unknown[] }): { ts: string; channel: string } {
    const method = "chat.postMessage";
    this.consumeFailure(method);
    validateMessage(method, input);
    if (input.threadTs !== undefined) this.enforceBrief(method, input);
    this.clock += 1;
    const digits = String(this.clock);
    const ts = `${digits.slice(0, 10)}.${digits.slice(10)}`;
    this.posts.push({ channel: input.channel, ...(input.threadTs === undefined ? {} : { threadTs: input.threadTs }), text: input.text, ...(input.blocks === undefined ? {} : { blocks: input.blocks }), ts });
    return { ts, channel: input.channel };
  }

  async postMessage(input: { channel: string; threadTs: string; text: string; blocks?: unknown[] }): Promise<void> {
    this.post(input);
  }

  update(input: { channel: string; ts: string; text: string; blocks: unknown[] }): void {
    const method = "chat.update";
    this.consumeFailure(method);
    validateMessage(method, input);
    // An edit of a thread message is still that thread message.
    const original = this.posts.find((post) => post.channel === input.channel && post.ts === input.ts);
    if (original?.threadTs !== undefined) this.enforceBrief(method, input);
    this.updates.push(input);
  }

  postEphemeral(input: { channel: string; threadTs?: string; user: string; text: string; blocks?: unknown[] }): void {
    const method = "chat.postEphemeral";
    this.consumeFailure(method);
    validateMessage(method, input);
    if (input.threadTs !== undefined) this.enforceBrief(method, input);
    this.ephemerals.push(input);
  }

  async openView(triggerId: string, view: Record<string, unknown>): Promise<void> {
    const method = "views.open";
    this.consumeFailure(method);
    if (triggerId === "") refuse(method, "invalid_trigger");
    if (view.type !== "modal") refuse(method, "invalid_arguments");
    for (const field of ["title", "submit", "close"]) {
      const text = textOf(view[field]);
      if (field === "title" && text === undefined) refuse(method, "invalid_arguments");
      if (text !== undefined && text.length > SLACK_LIMITS.modalTitle) refuse(method, "invalid_arguments");
    }
    if (view.private_metadata !== undefined && (typeof view.private_metadata !== "string" || view.private_metadata.length > SLACK_LIMITS.privateMetadata)) refuse(method, "invalid_arguments");
    validateBlocks(method, view.blocks, SLACK_LIMITS.modalBlocks, "modal");
    this.views.push({ triggerId, view });
  }

  async respondEphemeral(url: string, text: string): Promise<void> {
    if (!url.startsWith("https://hooks.slack.com/")) refuse("response_url", "invalid_arguments");
    // A button's private answer is read in the thread where the button was pressed.
    this.enforceBrief("response_url", { text });
    this.responses.push({ url, text });
  }

  lastPostWithAction(actionId: string): Post {
    const found = [...this.posts].reverse().find((post) => hasAction(post.blocks, actionId));
    if (found === undefined) throw new Error(`No post carries action ${actionId}`);
    return found;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = url.replace(/^https:\/\/slack\.com\/api\//, "");
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record_;
    const str = (value: unknown): string => (typeof value === "string" ? value : "");
    const answer = (payload: Record_) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    try {
      const text = typeof body.text === "string" ? body.text : "";
      const blocks = Array.isArray(body.blocks) ? body.blocks : undefined;
      const channel = str(body.channel);
      switch (method) {
        case "chat.postMessage": {
          const posted = this.post({ channel, text, ...(typeof body.thread_ts === "string" ? { threadTs: body.thread_ts } : {}), ...(blocks === undefined ? {} : { blocks }) });
          return answer({ ok: true, ts: posted.ts, channel: posted.channel });
        }
        case "chat.update":
          this.update({ channel, ts: str(body.ts), text, blocks: blocks ?? [] });
          return answer({ ok: true, channel, ts: str(body.ts) });
        case "chat.postEphemeral":
          this.postEphemeral({ channel, user: str(body.user), text, ...(typeof body.thread_ts === "string" ? { threadTs: body.thread_ts } : {}), ...(blocks === undefined ? {} : { blocks }) });
          return answer({ ok: true, message_ts: "0000000000.000000" });
        case "views.open":
          await this.openView(str(body.trigger_id), asRecord(body.view) ?? {});
          return answer({ ok: true });
        default:
          return answer({ ok: false, error: "unknown_method" });
      }
    } catch (error) {
      if (error instanceof SlackPostError) return answer({ ok: false, error: error.slackError });
      throw error;
    }
  };
}
