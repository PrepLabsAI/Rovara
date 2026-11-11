// The chat tool as an ordinary `channel` adapter (owner decision 58): Rovara's events go out as messages, and what people say comes back through the sink the core hands to `start`. The core, not this file, decides who may
// do what: a message runs nothing until the sink has checked the space, the person and the request, and a button press is only ever a request for the approval gate to refuse or accept (`core/channel`).
//
// What this adapter will not do, whatever it is told: it posts only to the workspace its own bot belongs to; it never puts a task's text, a plan or a token into a message beyond what the event carries; and the kinds of decision
// that ask for a sign-in (`plan_approval`, `admin`) are listed in `stepUp`, so a card for one carries no buttons.
import type { ChannelAdapter, ChannelCapabilities, ChannelEvent, ChannelInboundSink, StepUpKind } from "@agentx/contracts";
import { decisionOf, messageOf } from "./events.js";
import { NO_THREAD, renderEvent } from "./format.js";
import { startSocket, type SocketFactory } from "./socket.js";
import { SlackApiError, slackWeb, type SlackWeb } from "./web.js";

/** Messages stay short: the tool shows a longer one folded. */
export const SLACK_CAPABILITIES: ChannelCapabilities = { threads: true, buttons: 4, edits: false, maxTextLength: 3_000, proactive: true };
/** An event id is remembered this long (in memory) so a repeat of one in the same run is dropped. */
const SEEN_MAX = 1_000;

export interface SlackChannelOptions {
  /** The projects the adapter serves (a space is bound to one of them on the chat page). */
  projects: readonly string[];
  /** Reads the bot token; called for every request. */
  botToken: () => Promise<string>;
  /** Reads the app-level token; absent: the adapter only sends (notices), and hears nothing. */
  appToken?: (() => Promise<string>) | undefined;
  fetch?: typeof fetch | undefined;
  socket?: SocketFactory | undefined;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
  /** Waits between socket attempts (tests). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export class SlackChannel implements ChannelAdapter {
  readonly capabilities = SLACK_CAPABILITIES;
  readonly projects: readonly string[];
  readonly stepUp: readonly StepUpKind[] = ["plan_approval", "admin"];
  readonly noThread = NO_THREAD;
  private readonly web: SlackWeb;
  private readonly seen = new Set<string>();
  private identity: { teamId: string; botUserId: string } | undefined;

  constructor(private readonly options: SlackChannelOptions) {
    this.projects = [...options.projects];
    this.web = slackWeb({ botToken: options.botToken, appToken: options.appToken, fetch: options.fetch });
  }

  private async who(): Promise<{ teamId: string; botUserId: string }> {
    this.identity ??= await this.web.authTest();
    return this.identity;
  }

  async deliver(event: ChannelEvent): Promise<void> {
    if (event.channel !== "slack" || event.conversation.channel !== "slack") throw new SlackApiError("wrong_channel");
    // At least once: a repeat of an event id in this run is dropped, as an adapter must.
    if (this.seen.has(event.id)) return;
    const { teamId } = await this.who();
    // The bot posts only in its own workspace: a conversation of another one cannot be reached with its token.
    if (event.conversation.tenant !== teamId) throw new SlackApiError("wrong_workspace");
    const rendered = renderEvent(event, this.capabilities.maxTextLength);
    if (rendered === undefined) return;
    const threadTs = event.conversation.thread === NO_THREAD ? undefined : event.conversation.thread;
    if (rendered.ephemeralTo !== undefined) await this.web.postEphemeral({ channel: event.conversation.space, user: rendered.ephemeralTo, threadTs, text: rendered.text });
    else await this.web.postMessage({ channel: event.conversation.space, threadTs, text: rendered.text, blocks: rendered.blocks });
    this.seen.add(event.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
  }

  async start(sink: ChannelInboundSink): Promise<{ stop(): Promise<void> }> {
    // A token the tool does not accept stops the start with the tool's own error code, so `rovara up` says so.
    const bot = await this.who();
    if (this.options.appToken === undefined) return { stop: async () => undefined };
    const now = this.options.now ?? (() => new Date());
    const log = this.options.log ?? (() => undefined);
    const run = startSocket({
      web: this.web,
      ...(this.options.socket === undefined ? {} : { connect: this.options.socket }),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
      log,
      handle: async ({ type, payload }) => {
        if (type === "events_api") {
          const message = messageOf(payload, { userId: bot.botUserId }, now, log);
          if (message !== undefined) await sink.message(message);
        } else if (type === "interactive") {
          const decision = decisionOf(payload, now, log);
          if (decision !== undefined) await sink.decision(decision);
        }
      },
    });
    return { stop: () => run.stop() };
  }
}
