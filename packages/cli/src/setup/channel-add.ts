// FR-041: bind a Slack channel to a project. A public channel is joined; a private one needs a
// person to invite the bot (a bot cannot join a private channel), so the CLI waits for that.
// Everything here needs only the manifest's channels:read, groups:read and channels:join
// (SLACK_BOT_SCOPES in init/slack-app.ts). The bot token goes only in the authorization header.
import { agentXError } from "@agentx/contracts";
import { bindSlackChannel } from "../admin/slack.js";
import type { Prompter } from "../init/prompts.js";
import type { AdminSession, SetupServices } from "./services.js";

export interface SlackChannel { id: string; name: string; isPrivate: boolean; isMember: boolean }
export interface SlackChannelApi {
  /** conversations.list, public and private, not archived, every page; private ones only when the bot is in them. */
  find(token: string, name: string): Promise<SlackChannel | undefined>;
  /** conversations.join, for a public channel. */
  join(token: string, channelId: string): Promise<void>;
}

const FIND_WAIT_MS = 10 * 60_000;
const FIND_POLL_MS = 10_000;
const LIST_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 50;
const CHANNEL_NAME = /^#?[a-z0-9][a-z0-9_-]{0,79}$/i;

export function slackChannelApi(fetchImplementation: typeof fetch): SlackChannelApi {
  const call = async (method: string, token: string, params: Record<string, string>): Promise<Record<string, unknown>> => {
    const response = await fetchImplementation(`https://slack.com/api/${method}?${new URLSearchParams(params).toString()}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `Slack ${method} failed with HTTP ${response.status}; try again in a minute`);
    const body = (await response.json()) as Record<string, unknown>;
    if (body.ok !== true) {
      // Only a code shaped like Slack's documented ones is echoed.
      const code = typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? body.error : "unknown_error";
      const missingScope = code === "missing_scope";
      throw agentXError(missingScope ? "CONFIG_INVALID" : "RUNTIME_UNAVAILABLE", `Slack ${method} refused: ${code}${missingScope ? "; reinstall the Slack app from its manifest so it has channels:read, groups:read and channels:join" : ""}`);
    }
    return body;
  };
  return {
    async find(token, name) {
      let cursor = "";
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const body = await call("conversations.list", token, { types: "public_channel,private_channel", exclude_archived: "true", limit: String(LIST_PAGE_SIZE), ...(cursor === "" ? {} : { cursor }) });
        const channels = (Array.isArray(body.channels) ? body.channels : []) as Array<{ id: string; name: string; is_private?: boolean; is_member?: boolean }>;
        const match = channels.find((channel) => channel.name === name);
        if (match !== undefined) return { id: match.id, name: match.name, isPrivate: match.is_private === true, isMember: match.is_member === true };
        cursor = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
        if (cursor === "") return undefined;
      }
      throw agentXError("CONFIG_INVALID", `the workspace has more than ${MAX_LIST_PAGES * LIST_PAGE_SIZE} channels to search; bind the channel by id with agentx admin slack bind --team <team-id> --channel <channel-id> --project <name>`);
    },
    async join(token, channelId) {
      await call("conversations.join", token, { channel: channelId });
    },
  };
}

export function channelName(typed: string): string {
  return typed.trim().replace(/^#/, "").toLowerCase();
}

export async function addChannel(input: {
  session: AdminSession; botToken: string; teamId: string; botUserId: string; projectName: string;
  prompter: Prompter; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number;
  services: Pick<SetupServices, "fetch" | "slackChannels">; flags: { channel?: string };
}): Promise<{ channelId: string; channelName: string }> {
  const typed = input.flags.channel ?? await input.prompter.ask("Which Slack channel should the project use?", {
    flag: "--channel", validate: (value) => (CHANNEL_NAME.test(value.trim()) ? undefined : "a channel name, such as payments"),
  });
  if (!CHANNEL_NAME.test(typed.trim())) throw agentXError("CONFIG_INVALID", "--channel must be a Slack channel name, such as payments");
  const name = channelName(typed);
  const deadline = input.now() + FIND_WAIT_MS;
  let channel = await input.services.slackChannels.find(input.botToken, name);
  if (channel === undefined) {
    input.write(`The bot cannot see #${name} yet. If #${name} is private, type /invite <@${input.botUserId}> in it; if it does not exist, create it. Waiting up to 10 minutes.`);
    while (channel === undefined) {
      if (input.now() >= deadline) {
        throw agentXError("CONFIG_INVALID", `the bot cannot see a channel named #${name} after 10 minutes; create it in Slack (or invite the bot to it, if it is private), then run this again`);
      }
      await input.sleep(FIND_POLL_MS);
      channel = await input.services.slackChannels.find(input.botToken, name);
    }
  }
  if (!channel.isMember) {
    // Only a public channel can be listed while the bot is not in it.
    await input.services.slackChannels.join(input.botToken, channel.id);
    input.write(`The bot joined #${name}.`);
  }
  await bindSlackChannel({ controlPlaneUrl: input.session.controlPlaneUrl, accessToken: input.session.accessToken, teamId: input.teamId, channelId: channel.id, projectName: input.projectName }, input.services.fetch);
  input.write(`Bound #${name} to project ${input.projectName}.`);
  return { channelId: channel.id, channelName: name };
}
