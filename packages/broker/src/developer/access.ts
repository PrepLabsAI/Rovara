// Spec 025 FR-013: a developer may use a project granted to them, or, when the project allows it,
// any project with a bound channel their linked Slack user is in. Slack failures fail closed.
import { CHANNEL_MEMBERS_MAX_CHANNELS, SlackWorkspaceScopeSchema, type ChannelMembersRequest, type ChannelMembersResponse, type SlackChannelBinding } from "@agentx/contracts";

export interface DeveloperAccessInput {
  companyId?: string;
  grants: readonly string[];
  bindings: readonly SlackChannelBinding[];
  slackUserId?: string;
  channelMembersMayUse: (project: string) => boolean;
  channelMembers: (request: ChannelMembersRequest) => Promise<ChannelMembersResponse>;
}
export interface DeveloperAccess { projects: Map<string, { access: "granted" | "channel"; channels: string[] }>; slackUnavailable: boolean }

export async function resolveDeveloperAccess(input: DeveloperAccessInput): Promise<DeveloperAccess> {
  if (input.companyId !== undefined && (input.bindings.length > 2000 || input.grants.length > 2000)) return { projects: new Map(), slackUnavailable: true };
  const channelsOf = new Map<string, string[]>();
  for (const binding of input.bindings) channelsOf.set(binding.projectName, [...(channelsOf.get(binding.projectName) ?? []), binding.channelId].sort());
  const projects: DeveloperAccess["projects"] = new Map();
  for (const project of [...new Set(input.grants)].sort()) projects.set(project, { access: "granted", channels: channelsOf.get(project) ?? [] });

  const candidates = [...channelsOf.keys()].filter((project) => !projects.has(project) && input.channelMembersMayUse(project));
  if (input.slackUserId === undefined || candidates.length === 0) return { projects: sorted(projects), slackUnavailable: false };
  if (input.companyId !== undefined) {
    // Membership keys include the team: Slack IDs alone are not globally unique.
    const byTeam = new Map<string, Set<string>>();
    const candidateSet = new Set(candidates);
    for (const binding of input.bindings) {
      if (!candidateSet.has(binding.projectName)) continue;
      if (!SlackWorkspaceScopeSchema.safeParse({ companyId: input.companyId, teamId: binding.teamId }).success) return { projects: sorted(projects), slackUnavailable: true };
      const channels = byTeam.get(binding.teamId) ?? new Set<string>();
      channels.add(binding.channelId); byTeam.set(binding.teamId, channels);
    }
    const member = new Set<string>();
    const started = Date.now(); let bytes = 0;
    for (const [teamId, ids] of byTeam) {
      const channelIds = [...ids].sort();
      for (let start = 0; start < channelIds.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
        if (Date.now() - started > 10_000) return { projects: sorted(projects), slackUnavailable: true };
        const requested = channelIds.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS);
        const answer = await input.channelMembers({ kind: "channel-members", slackUserId: input.slackUserId, channelIds: requested, workspace: { companyId: input.companyId, teamId } });
        bytes += JSON.stringify(answer).length;
        if (!answer.ok || bytes > 1_000_000 || Date.now() - started > 10_000 || answer.memberOf.some((id) => !requested.includes(id))) return { projects: sorted(projects), slackUnavailable: true };
        for (const id of answer.memberOf) member.add(`${teamId}/${id}`);
      }
    }
    for (const binding of input.bindings) if (candidateSet.has(binding.projectName) && member.has(`${binding.teamId}/${binding.channelId}`)) {
      projects.set(binding.projectName, { access: "channel", channels: channelsOf.get(binding.projectName) ?? [] });
    }
    return { projects: sorted(projects), slackUnavailable: false };
  }
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

/**
 * FR-049's PROJECT_ACCESS_DENIED text. The caller passes only public bound channels (R10): a
 * person in any bound channel already has access when channelMembersMayUse is on, so those are the
 * only bound channels they can see. No names means "ask an admin".
 */
export function accessDeniedMessage(project: string, channelNames: readonly string[]): string {
  if (channelNames.length === 0) return `you don't have access to \`${project}\`: ask an admin`;
  return `you don't have access to \`${project}\`: join one of its channels (${channelNames.map((name) => `#${name}`).join(", ")}) or ask an admin`;
}
