// The retired shareFor/confirmMayShareInto, using the same deployment readers and channel proof.
import { AgentXError, SlackChannelIdSchema, agentXError, type DeveloperTaskPolicy } from "@agentx/contracts";
import type { DeveloperCaller } from "./developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "./developer-tasks.js";
import { decideShare, type BoundChannel } from "../developer/share.js";
import { taskShare, type TaskShare } from "../developer/task-records.js";

export async function prepareCoreShare(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, project: string, policy: DeveloperTaskPolicy, wanted: { shareToChannel: boolean; shareMode?: "view" | "continue" | undefined; channel?: string | undefined }): Promise<TaskShare | undefined> {
  if (!wanted.shareToChannel && policy.share !== "required") return undefined;
  const workspace = await deps.workspaceForProject?.(project);
  const ids = await deps.projectChannelIds(project);
  const looked: BoundChannel[] = deps.boundChannels === undefined ? ids.map(channelId => ({ channelId })) : await deps.boundChannels(ids, workspace);
  const linked = caller.slackUserId !== undefined;
  const bound: BoundChannel[] = linked ? looked : looked.map(({ channelId, isPrivate }) => ({ channelId, ...(isPrivate === undefined ? {} : { isPrivate }) }));
  let decision;
  try {
    decision = decideShare({ project, policy, bound, shareToChannel: wanted.shareToChannel, ...(wanted.shareMode === undefined ? {} : { shareMode: wanted.shareMode }), ...(wanted.channel === undefined ? {} : { channel: wanted.channel }) });
  } catch (error) {
    const byName = wanted.channel !== undefined && !SlackChannelIdSchema.safeParse(wanted.channel).success;
    if (linked && deps.boundChannels !== undefined && byName && error instanceof AgentXError && error.code === "CHANNEL_REQUIRED" && bound.some(channel => channel.name === undefined)) {
      throw agentXError("CHANNEL_REQUIRED", `Rovara could not read the channel names from Slack; name the channel by its ID: ${bound.map(channel => channel.channelId).sort().join(", ")}`);
    }
    throw error;
  }
  if (decision === undefined) return undefined;
  await requireChannelMembership(deps, caller, bound.find(channel => channel.channelId === decision.channelId), decision.channelId, workspace);
  const teamId = workspace?.teamId ?? deps.slackTeamId;
  if (teamId === undefined) throw agentXError("CHANNEL_REQUIRED", "this install has no Slack workspace set, so tasks cannot be shared");
  return taskShare(decision, teamId, new Date(deps.now?.() ?? Date.now()).toISOString());
}

async function requireChannelMembership(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, channel: BoundChannel | undefined, channelId: string, workspace: Awaited<ReturnType<NonNullable<DeveloperTaskRouteDependencies["workspaceForProject"]>>>): Promise<void> {
  if (channel?.isPrivate !== false) {
    const refusal = () => channel?.isPrivate === true
      ? agentXError("CHANNEL_REQUIRED", "you are not a member of that private channel; join it first, or share to one of the project's public channels")
      : agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check whether that channel is private; try again shortly");
    if (caller.slackUserId === undefined || deps.channelMember === undefined || !await deps.channelMember(caller.slackUserId, channelId, workspace)) throw refusal();
  }
}
