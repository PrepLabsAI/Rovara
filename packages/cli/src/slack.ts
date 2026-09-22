import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import { agentXError } from "@agentx/contracts";
import {
  createOrchestratorRuntime,
  type OrchestratorOptions,
} from "./orchestrator.js";
import type { SlackProjectConfiguration } from "./slack-config.js";

const MAX_SLACK_MESSAGE_LENGTH = 3_500;
const MAX_DEDUPLICATION_ENTRIES = 1_000;

export interface SlackLogEntry {
  level: "info" | "warn" | "error";
  event: string;
  fields?: Readonly<Record<string, string | number | boolean>>;
}

export type SlackLogger = (entry: SlackLogEntry) => void;

const NOOP_SLACK_LOGGER: SlackLogger = () => undefined;

export interface SlackMention {
  eventId: string;
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
  messageTimestamp: string;
  threadTimestamp?: string;
  botUserId?: string;
}

export interface SlackTransport {
  start(listener: (mention: SlackMention) => void): Promise<void>;
  postMessage(input: { channelId: string; threadTimestamp: string; text: string }): Promise<void>;
  stop(): Promise<void>;
}

export interface SlackPromptTarget {
  prompt(text: string): Promise<string>;
}

export class SlackProjectBridge {
  private readonly seenEventIds = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private queuedTaskCount = 0;

  constructor(
    private readonly configuration: SlackProjectConfiguration,
    private readonly transport: SlackTransport,
    private readonly target: SlackPromptTarget,
    private readonly log: SlackLogger = NOOP_SLACK_LOGGER,
  ) {}

  async start(): Promise<void> {
    this.log({
      level: "info",
      event: "bridge.starting",
      fields: configurationLogFields(this.configuration),
    });
    await this.transport.start((mention) => {
      void this.accept(mention).catch((error: unknown) => {
        this.log({
          level: "error",
          event: "mention.processing_failed",
          fields: { eventId: mention.eventId, ...diagnosticErrorFields(error) },
        });
      });
    });
    this.log({
      level: "info",
      event: "bridge.ready",
      fields: configurationLogFields(this.configuration),
    });
  }

  async stop(): Promise<void> {
    this.log({ level: "info", event: "bridge.stopping", fields: { queuedTasks: this.queuedTaskCount } });
    await this.queue.catch(() => undefined);
    await this.transport.stop();
    this.log({ level: "info", event: "bridge.stopped" });
  }

  async accept(mention: SlackMention): Promise<boolean> {
    if (mention.teamId !== this.configuration.teamId) {
      this.logIgnoredMention(mention, "team_mismatch", {
        expectedTeamId: this.configuration.teamId,
        actualTeamId: mention.teamId,
      });
      return false;
    }
    if (mention.channelId !== this.configuration.channelId) {
      this.logIgnoredMention(mention, "channel_mismatch", {
        expectedChannelId: this.configuration.channelId,
        actualChannelId: mention.channelId,
      });
      return false;
    }
    if (!this.configuration.allowedUserIds.includes(mention.userId)) {
      this.logIgnoredMention(mention, "user_not_allowed", { userId: mention.userId });
      return false;
    }
    if (this.seenEventIds.has(mention.eventId)) {
      this.logIgnoredMention(mention, "duplicate_event");
      return false;
    }
    rememberEvent(this.seenEventIds, mention.eventId);
    const threadTimestamp = mention.threadTimestamp ?? mention.messageTimestamp;
    const prompt = removeBotMention(mention.text, mention.botUserId);
    if (prompt.length === 0) {
      this.log({
        level: "warn",
        event: "mention.empty",
        fields: mentionLogFields(mention),
      });
      await this.transport.postMessage({
        channelId: mention.channelId,
        threadTimestamp,
        text: "Please include a task after mentioning AgentX.",
      });
      return true;
    }
    this.log({
      level: "info",
      event: "mention.accepted",
      fields: { ...mentionLogFields(mention), promptLength: prompt.length },
    });
    await this.transport.postMessage({
      channelId: mention.channelId,
      threadTimestamp,
      text: `Accepted for project ${this.configuration.projectName}. I’ll reply in this thread when it finishes.`,
    });
    this.queuedTaskCount += 1;
    this.log({
      level: "info",
      event: "task.queued",
      fields: { eventId: mention.eventId, queuedTasks: this.queuedTaskCount },
    });
    this.queue = this.queue.then(
      () => this.runPrompt(mention.eventId, mention.channelId, threadTimestamp, prompt),
      () => this.runPrompt(mention.eventId, mention.channelId, threadTimestamp, prompt),
    );
    return true;
  }

  async idle(): Promise<void> {
    await this.queue;
  }

  private async runPrompt(
    eventId: string,
    channelId: string,
    threadTimestamp: string,
    prompt: string,
  ): Promise<void> {
    const startedAt = Date.now();
    this.log({ level: "info", event: "task.started", fields: { eventId, promptLength: prompt.length } });
    try {
      const response = await this.target.prompt(prompt);
      const chunks = splitSlackMessage(response);
      this.log({
        level: "info",
        event: "task.completed",
        fields: {
          eventId,
          durationMs: Date.now() - startedAt,
          responseLength: response.length,
          responseChunks: chunks.length,
        },
      });
      for (const text of chunks) {
        await this.transport.postMessage({ channelId, threadTimestamp, text });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown local orchestrator failure";
      this.log({
        level: "error",
        event: "task.failed",
        fields: {
          eventId,
          durationMs: Date.now() - startedAt,
          ...diagnosticErrorFields(error),
        },
      });
      await this.transport.postMessage({
        channelId,
        threadTimestamp,
        text: `AgentX could not complete the request: ${message}`,
      });
    } finally {
      this.queuedTaskCount -= 1;
      this.log({
        level: "info",
        event: "task.finished",
        fields: { eventId, queuedTasks: this.queuedTaskCount },
      });
    }
  }

  private logIgnoredMention(
    mention: SlackMention,
    reason: string,
    fields: Readonly<Record<string, string | number | boolean>> = {},
  ): void {
    this.log({
      level: "warn",
      event: "mention.ignored",
      fields: { ...mentionLogFields(mention), reason, ...fields },
    });
  }
}

export interface SlackModeOptions {
  configuration: SlackProjectConfiguration;
  appToken: string;
  botToken: string;
  orchestrator: OrchestratorOptions;
  onReady?: () => void;
  log?: SlackLogger;
}

export async function runSlackMode(options: SlackModeOptions): Promise<void> {
  const log = options.log ?? NOOP_SLACK_LOGGER;
  assertSlackToken(options.appToken, "xapp-", "SLACK_APP_TOKEN");
  assertSlackToken(options.botToken, "xoxb-", "SLACK_BOT_TOKEN");
  log({
    level: "info",
    event: "orchestrator.initializing",
    fields: {
      project: options.configuration.projectName,
      provider: options.orchestrator.model.provider,
      model: options.orchestrator.model.modelId,
    },
  });
  const runtime = await createOrchestratorRuntime(options.orchestrator);
  log({ level: "info", event: "orchestrator.initialized" });
  const transport = new BoltSocketModeTransport(options.appToken, options.botToken, log);
  const bridge = new SlackProjectBridge(options.configuration, transport, {
    prompt: async (text) => {
      await runtime.session.prompt(text, { expandPromptTemplates: false });
      await runtime.session.waitForIdle();
      return lastAssistantText(runtime.session.messages);
    },
  }, log);
  try {
    await bridge.start();
    options.onReady?.();
    await waitForShutdownSignal();
  } finally {
    await bridge.stop();
    await runtime.dispose();
  }
}

class BoltSocketModeTransport implements SlackTransport {
  private readonly app: App;
  private readonly receiver: SocketModeReceiver;
  private listener?: (mention: SlackMention) => void;

  constructor(appToken: string, botToken: string, private readonly log: SlackLogger) {
    this.receiver = new SocketModeReceiver({
      appToken,
      logLevel: LogLevel.INFO,
    });
    this.attachSocketDiagnostics();
    this.app = new App({
      token: botToken,
      receiver: this.receiver,
      logLevel: LogLevel.INFO,
    });
    this.app.error(async (error) => {
      this.log({ level: "error", event: "socket.error", fields: diagnosticErrorFields(error) });
    });
    this.app.event("app_mention", async ({ event, body, context }) => {
      this.log({
        level: "info",
        event: "socket.event_received",
        fields: {
          eventType: "app_mention",
          eventId: body.event_id,
          teamId: body.team_id,
          channelId: event.channel,
          ...("user" in event && event.user ? { userId: event.user } : {}),
          hasBotId: Boolean(event.bot_id),
          textLength: event.text.length,
        },
      });
      if (!event.user) {
        this.log({
          level: "warn",
          event: "socket.event_ignored",
          fields: { eventId: body.event_id, reason: "missing_user" },
        });
        return;
      }
      if (event.bot_id) {
        this.log({
          level: "warn",
          event: "socket.event_ignored",
          fields: { eventId: body.event_id, reason: "bot_event" },
        });
        return;
      }
      if (!this.listener) {
        this.log({
          level: "warn",
          event: "socket.event_ignored",
          fields: { eventId: body.event_id, reason: "listener_unavailable" },
        });
        return;
      }
      this.listener?.({
        eventId: body.event_id,
        teamId: body.team_id,
        channelId: event.channel,
        userId: event.user,
        text: event.text,
        messageTimestamp: event.ts,
        ...(event.thread_ts === undefined ? {} : { threadTimestamp: event.thread_ts }),
        ...(context.botUserId === undefined ? {} : { botUserId: context.botUserId }),
      });
    });
  }

  async start(listener: (mention: SlackMention) => void): Promise<void> {
    this.listener = listener;
    this.log({ level: "info", event: "socket.connecting" });
    try {
      await this.app.start();
      this.log({ level: "info", event: "socket.connected" });
    } catch (error) {
      this.log({ level: "error", event: "socket.connection_failed", fields: diagnosticErrorFields(error) });
      throw error;
    }
  }

  async postMessage(input: { channelId: string; threadTimestamp: string; text: string }): Promise<void> {
    this.log({
      level: "info",
      event: "message.posting",
      fields: {
        channelId: input.channelId,
        threadTimestamp: input.threadTimestamp,
        textLength: input.text.length,
      },
    });
    try {
      await this.app.client.chat.postMessage({
        channel: input.channelId,
        thread_ts: input.threadTimestamp,
        text: input.text,
        unfurl_links: false,
        unfurl_media: false,
      });
      this.log({
        level: "info",
        event: "message.posted",
        fields: { channelId: input.channelId, threadTimestamp: input.threadTimestamp },
      });
    } catch (error) {
      this.log({
        level: "error",
        event: "message.post_failed",
        fields: {
          channelId: input.channelId,
          threadTimestamp: input.threadTimestamp,
          ...diagnosticErrorFields(error),
        },
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.log({ level: "info", event: "socket.disconnecting" });
    await this.app.stop();
    this.log({ level: "info", event: "socket.disconnected" });
  }

  private attachSocketDiagnostics(): void {
    for (const event of ["connecting", "connected", "reconnecting", "disconnecting", "disconnected"] as const) {
      this.receiver.client.on(event, () => {
        this.log({ level: "info", event: `socket.state.${event}` });
      });
    }
    this.receiver.client.on("error", (error: unknown) => {
      this.log({ level: "error", event: "socket.client_error", fields: diagnosticErrorFields(error) });
    });
    this.receiver.client.on("slack_event", (value: unknown) => {
      const envelope = asRecord(value);
      const body = asRecord(envelope.body);
      const event = asRecord(body.event);
      this.log({
        level: "info",
        event: "socket.envelope_received",
        fields: compactLogFields({
          envelopeId: primitiveLogValue(envelope.envelope_id),
          envelopeType: primitiveLogValue(envelope.type),
          retryNumber: primitiveLogValue(envelope.retry_num),
          retryReason: primitiveLogValue(envelope.retry_reason),
          apiAppId: primitiveLogValue(body.api_app_id),
          teamId: primitiveLogValue(body.team_id),
          eventId: primitiveLogValue(body.event_id),
          eventType: primitiveLogValue(event.type),
          channelId: primitiveLogValue(event.channel),
          userId: primitiveLogValue(event.user),
          hasBotId: typeof event.bot_id === "string",
          textLength: typeof event.text === "string" ? event.text.length : undefined,
        }),
      });
    });
  }
}

export function formatSlackLogEntry(entry: SlackLogEntry, timestamp = new Date()): string {
  const fields = Object.entries(entry.fields ?? {})
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ");
  return `${timestamp.toISOString()} [agentx:slack] ${entry.level.toUpperCase()} ${entry.event}${fields ? ` ${fields}` : ""}\n`;
}

export function removeBotMention(text: string, botUserId?: string): string {
  const withoutMention = botUserId
    ? text.replace(new RegExp(`<@${botUserId}>`, "gu"), "")
    : text.replace(/^\s*<@[A-Z0-9]+>\s*/u, "");
  return withoutMention.trim();
}

export function splitSlackMessage(text: string): string[] {
  const normalized = text.trim() || "AgentX completed the request without returning a textual response.";
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > MAX_SLACK_MESSAGE_LENGTH) {
    const boundary = Math.max(
      remaining.lastIndexOf("\n", MAX_SLACK_MESSAGE_LENGTH),
      remaining.lastIndexOf(" ", MAX_SLACK_MESSAGE_LENGTH),
    );
    const end = boundary > MAX_SLACK_MESSAGE_LENGTH / 2 ? boundary : MAX_SLACK_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, end).trimEnd());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function lastAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const candidate = message as Record<string, unknown>;
    if (candidate.role !== "assistant") continue;
    if (candidate.stopReason === "error" && typeof candidate.errorMessage === "string") {
      throw agentXError("RUNTIME_UNAVAILABLE", candidate.errorMessage);
    }
    if (!Array.isArray(candidate.content)) continue;
    const text = candidate.content
      .flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const content = block as Record<string, unknown>;
        return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
      })
      .join("\n")
      .replace(/<thinking>[\s\S]*?<\/thinking>\s*/giu, "")
      .trim();
    if (text.length > 0) return text;
  }
  return "AgentX completed the request without returning a textual response.";
}

function rememberEvent(seen: Set<string>, eventId: string): void {
  seen.add(eventId);
  if (seen.size <= MAX_DEDUPLICATION_ENTRIES) return;
  const oldest = seen.values().next().value;
  if (oldest !== undefined) seen.delete(oldest);
}

function assertSlackToken(value: string, prefix: string, variable: string): void {
  if (!value.startsWith(prefix) || value.length <= prefix.length) {
    throw agentXError("AUTH_REQUIRED", `${variable} must contain a Slack ${prefix} token`);
  }
}

function configurationLogFields(
  configuration: SlackProjectConfiguration,
): Readonly<Record<string, string | number | boolean>> {
  return {
    project: configuration.projectName,
    teamId: configuration.teamId,
    channelId: configuration.channelId,
    allowedUsers: configuration.allowedUserIds.length,
  };
}

function mentionLogFields(mention: SlackMention): Readonly<Record<string, string | number | boolean>> {
  return {
    eventId: mention.eventId,
    teamId: mention.teamId,
    channelId: mention.channelId,
    userId: mention.userId,
    messageTimestamp: mention.messageTimestamp,
    isThreadReply: mention.threadTimestamp !== undefined,
    textLength: mention.text.length,
  };
}

function diagnosticErrorFields(error: unknown): Readonly<Record<string, string | number | boolean>> {
  if (!error || typeof error !== "object") return { errorType: typeof error };
  const candidate = error as Record<string, unknown>;
  const fields: Record<string, string | number | boolean> = {
    errorType: error instanceof Error ? error.name : "object",
  };
  if (typeof candidate.code === "string" || typeof candidate.code === "number") {
    fields.errorCode = candidate.code;
  }
  const data = candidate.data;
  if (data && typeof data === "object") {
    const slackError = (data as Record<string, unknown>).error;
    if (typeof slackError === "string") fields.slackError = slackError;
  }
  return fields;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function primitiveLogValue(value: unknown): string | number | boolean | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

function compactLogFields(
  fields: Readonly<Record<string, string | number | boolean | undefined>>,
): Readonly<Record<string, string | number | boolean>> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );
}

function formatLogValue(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}
