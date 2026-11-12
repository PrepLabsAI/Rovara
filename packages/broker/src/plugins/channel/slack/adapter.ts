// The chat tool as an ordinary `channel` adapter (owner decision 58): Rovara's events go out as messages, and what people say comes back through the sink the core hands to `start`. The core, not this file, decides who may
// do what: a message runs nothing until the sink has checked the space, the person and the request, and a button press is only ever a request for the approval gate to refuse or accept (`core/channel`).
//
// What this adapter will not do, whatever it is told: it posts only to the workspace its own bot belongs to; it never puts a task's text, a plan or a token into a message beyond what the event carries; and the kinds of decision
// that ask for a sign-in (`plan_approval`, `admin`) are listed in `stepUp`, so a card for one carries no buttons.
import type { ChannelAdapter, ChannelCapabilities, ChannelEvent, ChannelInboundSink, StepUpKind } from "@agentx/contracts";
import { changesPressOf, changesSubmissionOf, decisionOf, messageOf } from "./events.js";
import { CHANGES_INPUT, NO_THREAD, changesModal, escapeText, renderEvent } from "./format.js";
import { startSocket, type SocketFactory } from "./socket.js";
import { SlackApiError, slackWeb, type SlackWeb } from "./web.js";

/** Messages stay short: the tool shows a longer one folded. */
// `forms`: a press of Request changes opens a box that asks "What should change?", and the words typed in it are the reason that goes with the request.
export const SLACK_CAPABILITIES: ChannelCapabilities = { threads: true, buttons: 4, edits: false, maxTextLength: 3_000, proactive: true, forms: true };
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

const EXPIRED_WORDS = (taskUrl: string | undefined): string => `That button expired. Open the task page to ask for changes${taskUrl === undefined ? " (`rovara open`)." : `: ${taskUrl}`}`;
const OTHER_PERSON_WORDS = "That box was opened by someone else, so nothing was sent. Press Request changes yourself.";
const UNREADABLE_WORDS = "That box could not be read, so nothing was sent. Press Request changes again.";

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

  /** A short private note to one person in a thread (failures are logged by code, never thrown: the note is a courtesy). */
  private async whisper(to: { channel: string; thread: string; user: string }, text: string): Promise<void> {
    try {
      await this.web.postEphemeral({ channel: to.channel, user: to.user, threadTs: to.thread === NO_THREAD ? undefined : to.thread, text: escapeText(text) });
    } catch (error) {
      this.options.log?.({ event: "slack.note_failed", code: error instanceof SlackApiError ? error.code : "unknown" });
    }
  }

  async deliver(event: ChannelEvent): Promise<void> {
    if (event.channel !== "slack") throw new SlackApiError("wrong_channel");
    // A message to one person outside any conversation needs the `direct` ability, which this adapter does not declare, so the core never sends one here.
    if (event.type === "direct") throw new SlackApiError("direct_not_supported");
    if (event.conversation.channel !== "slack") throw new SlackApiError("wrong_channel");
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
      // The box that asks what should change: nothing typed shows an error and stays open; one that is not the opener's, or does not read, is closed.
      answer: ({ type, payload }) => {
        if (type !== "interactive") return undefined;
        const submission = changesSubmissionOf(payload, { userId: bot.botUserId }, now, log);
        if (submission?.status === "empty") return { response_action: "errors", errors: { [CHANGES_INPUT]: "Say what should change." } };
        return submission?.status === "refused" ? { response_action: "clear" } : undefined;
      },
      handle: async ({ type, payload }) => {
        if (type === "events_api") {
          const message = messageOf(payload, { userId: bot.botUserId }, now, log);
          if (message !== undefined) await sink.message(message);
        } else if (type === "interactive") {
          const changes = changesPressOf(payload, log);
          if (changes !== undefined) {
            try {
              await this.web.openView({ triggerId: changes.triggerId, view: changesModal(changes.context) });
            } catch (error) {
              // The press's trigger is good for a few seconds only: say so, privately, and where to ask for changes instead.
              log({ event: "slack.changes_box_failed", code: error instanceof SlackApiError ? error.code : "unknown" });
              await this.whisper({ channel: changes.context.s, thread: changes.context.h, user: changes.context.u }, EXPIRED_WORDS(changes.taskUrl));
            }
            return;
          }
          const submission = changesSubmissionOf(payload, { userId: bot.botUserId }, now, log);
          if (submission !== undefined) {
            if (submission.status === "ok") await sink.decision(submission.decision);
            else if (submission.status === "refused" && submission.notify !== undefined) await this.whisper(submission.notify, submission.why === "other_person" ? OTHER_PERSON_WORDS : UNREADABLE_WORDS);
            return;
          }
          const decision = decisionOf(payload, now, log);
          if (decision !== undefined) await sink.decision(decision);
        }
      },
    });
    return { stop: () => run.stop() };
  }
}
