// L4-U5b: the hosted chat seam for Slack (`core-host/chat-threads.ts`): which company a Slack workspace (team) belongs to, and one Slack adapter per company. The adapter is the same one a laptop runs (`SlackChannel`: it renders
// an event as a Slack message and posts it), but its bot token is the COMPANY's token for the conversation's own workspace (`slackCallerToken`: the workspace must belong to the company, or no token is given), and it posts
// only in the workspace that token belongs to. So a conversation of another company's workspace cannot be reached from this company's milestones, and a workspace with no token for it posts nothing.
import { SLACK_CHANNEL, type ChannelAdapter, type ChannelEvent, type OrgId } from "@agentx/contracts";
import type { ChatThreads } from "../core-host/chat-threads.js";
import { SLACK_CAPABILITIES, SlackChannel } from "../plugins/channel/slack/index.js";
import { slackCallerToken, type SlackCallerWorkspaces } from "./slack-workspace-tokens.js";

export interface HostedSlackThreadsOptions {
  workspaces: SlackCallerWorkspaces;
  fetch?: typeof fetch | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export function hostedSlackThreads(options: HostedSlackThreadsOptions): ChatThreads {
  const { workspaces } = options;
  const adapters = new Map<string, ChannelAdapter>();
  const adapterOf = (companyId: OrgId): ChannelAdapter => {
    let found = adapters.get(companyId);
    if (found === undefined) {
      // One Slack adapter per (company, workspace), made when first used. Its token is read for every request, and only for a workspace of this company.
      const perTeam = new Map<string, SlackChannel>();
      const channelFor = (teamId: string): SlackChannel => {
        let channel = perTeam.get(teamId);
        if (channel === undefined) {
          channel = new SlackChannel({ projects: [], botToken: () => slackCallerToken(workspaces, { companyId, teamId }), ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.log === undefined ? {} : { log: options.log }) });
          perTeam.set(teamId, channel);
        }
        return channel;
      };
      found = {
        capabilities: SLACK_CAPABILITIES, projects: [], stepUp: ["plan_approval", "admin"],
        async deliver(event: ChannelEvent): Promise<void> {
          // A person-to-person message has no conversation here, and only a Slack conversation is ours.
          if (event.type === "direct" || event.channel !== SLACK_CHANNEL || event.conversation.channel !== SLACK_CHANNEL) throw new Error("not a Slack conversation");
          await channelFor(event.conversation.tenant).deliver(event);
        },
      };
      adapters.set(companyId, found);
    }
    return found;
  };
  return {
    channels: [SLACK_CHANNEL],
    async companyOf({ channel, tenant }) {
      if (channel !== SLACK_CHANNEL) return undefined;
      try { return await workspaces.requireCompany(tenant); } catch { return undefined; }
    },
    adapterFor: (companyId, channel) => (channel === SLACK_CHANNEL ? adapterOf(companyId) : undefined),
  };
}
