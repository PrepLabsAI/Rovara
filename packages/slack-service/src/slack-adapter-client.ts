// Spec 062 Phase 7c2: the Slack service's own posts through the built-in Slack adapter, where it must know what was
// posted (a routing card it edits later) or must keep it private (a task question's answer). Each is a signed command
// to the deployment's own adapter, answered at once.
import {
  SLACK_CHANNEL,
  channelMessageOfSlackBlocks,
  sendSignedChannelCommand,
  type ChannelCommandInput,
  type ChannelCommandKind,
  type ChannelCommandResult,
  type SlackThread,
} from "@rovara-code/contracts";

export interface SlackAdapterClient {
  /** Posts in the thread and answers the message's timestamp. */
  post(thread: SlackThread, text: string, blocks?: unknown[]): Promise<string | undefined>;
  /** A message only `userId` sees in the thread. */
  postPrivate(thread: SlackThread, userId: string, text: string): Promise<void>;
}

export function createSlackAdapterClient(deps: { commandsUrl: string; secret(): Promise<string | undefined>; fetch?: typeof fetch; now?: () => number }): SlackAdapterClient {
  const url = new URL(deps.commandsUrl);
  const send = async <K extends ChannelCommandKind>(kind: K, input: ChannelCommandInput<K>): Promise<ChannelCommandResult<K>> => {
    const secret = await deps.secret();
    if (secret === undefined) throw new Error("the Slack adapter's signing secret could not be read");
    return sendSignedChannelCommand({ url, secret, channel: SLACK_CHANNEL, fetch: deps.fetch ?? fetch, now: deps.now ?? Date.now }, kind, input);
  };
  return {
    async post(thread, text, blocks) {
      // A card the adapter cannot read back goes as its text alone.
      const message = (blocks === undefined ? undefined : channelMessageOfSlackBlocks(text, blocks)) ?? { text };
      return (await send("post_message", { tenant: thread.teamId, space: thread.channelId, thread: thread.threadTs, message })).messageId;
    },
    async postPrivate(thread, userId, text) {
      await send("post_message", { tenant: thread.teamId, space: thread.channelId, thread: thread.threadTs, message: { text },
        audience: { kind: "ephemeral", actor: { channel: SLACK_CHANNEL, tenant: thread.teamId, userId } } });
    },
  };
}
