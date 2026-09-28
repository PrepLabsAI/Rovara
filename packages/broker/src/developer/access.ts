// Spec 025 FR-013: a developer may use a project granted to them, or, when the project allows it,
// any project with a bound channel their linked Slack user is in. Slack failures fail closed.
import { CHANNEL_MEMBERS_MAX_CHANNELS, type ChannelMembersRequest, type ChannelMembersResponse, type SlackChannelBinding } from "@agentx/contracts";

export interface DeveloperAccessInput {
  grants: readonly string[];
  bindings: readonly SlackChannelBinding[];
  slackUserId?: string;
  channelMembersMayUse: (project: string) => boolean;
  channelMembers: (request: ChannelMembersRequest) => Promise<ChannelMembersResponse>;
}
export interface DeveloperAccess { projects: Map<string, { access: "granted" | "channel"; channels: string[] }>; slackUnavailable: boolean }

export async function resolveDeveloperAccess(input: DeveloperAccessInput): Promise<DeveloperAccess> {
  const channelsOf = new Map<string, string[]>();
  for (const binding of input.bindings) channelsOf.set(binding.projectName, [...(channelsOf.get(binding.projectName) ?? []), binding.channelId].sort());
  const projects: DeveloperAccess["projects"] = new Map();
  for (const project of [...new Set(input.grants)].sort()) projects.set(project, { access: "granted", channels: channelsOf.get(project) ?? [] });

  const candidates = [...channelsOf.keys()].filter((project) => !projects.has(project) && input.channelMembersMayUse(project));
  if (input.slackUserId === undefined || candidates.length === 0) return { projects: sorted(projects), slackUnavailable: false };
  const channelIds = [...new Set(candidates.flatMap((project) => channelsOf.get(project) ?? []))].sort();
  const member = new Set<string>();
  for (let start = 0; start < channelIds.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
    const answer = await input.channelMembers({ kind: "channel-members", slackUserId: input.slackUserId, channelIds: channelIds.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS) });
    if (!answer.ok) return { projects: sorted(projects), slackUnavailable: true };
    for (const channel of answer.memberOf) member.add(channel);
  }
  for (const project of candidates) {
    const channels = channelsOf.get(project) ?? [];
    if (channels.some((channel) => member.has(channel))) projects.set(project, { access: "channel", channels });
  }
  return { projects: sorted(projects), slackUnavailable: false };
}

const sorted = <V>(map: Map<string, V>) => new Map([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
