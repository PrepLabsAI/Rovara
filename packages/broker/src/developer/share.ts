// Spec 025 FR-031, D5, D6: whether a task is shared, where, and in which mode. No I/O.
import { agentXError, type DeveloperTaskPolicy } from "@agentx/contracts";

export interface BoundChannel { channelId: string; name?: string; isPrivate?: boolean }
export interface ShareDecision {
  channelId: string;
  channelName?: string;
  mode: "view" | "continue";
  sharedReason: "requested" | "required";
  modeReason?: "continue_not_allowed";
}

/** A channel as a refusal names it: `#name` when public and known, else its ID only (R10). */
export function channelLabel(channel: BoundChannel): string {
  return channel.name !== undefined && channel.isPrivate === false ? `#${channel.name}` : channel.channelId;
}

const SAFE_ECHO = /^#?[A-Za-z0-9._-]{1,80}$/;
const byId = (left: BoundChannel, right: BoundChannel) => (left.channelId < right.channelId ? -1 : left.channelId > right.channelId ? 1 : 0);

/** D5: continue on a project that does not allow it becomes view, with the reason. */
export function decideMode(policy: DeveloperTaskPolicy, wanted: "view" | "continue"): { mode: "view" | "continue"; modeReason?: "continue_not_allowed" } {
  return wanted === "continue" && !policy.shareMode.allowContinue ? { mode: "view", modeReason: "continue_not_allowed" } : { mode: wanted };
}

function pickChannel(project: string, bound: readonly BoundChannel[], wanted: string | undefined): BoundChannel {
  const channels = [...bound].sort(byId);
  const list = channels.map(channelLabel).join(", ");
  if (channels.length === 0) {
    throw agentXError("CHANNEL_REQUIRED", `project \`${project}\` has no Slack channel bound to it, so the task cannot be shared`);
  }
  if (wanted !== undefined) {
    const name = wanted.replace(/^#/, "").toLowerCase();
    const found = channels.find((channel) => channel.channelId === wanted || (channel.isPrivate === false && channel.name?.toLowerCase() === name));
    if (found === undefined) {
      const echo = SAFE_ECHO.test(wanted) ? `\`${wanted}\`` : "that channel";
      throw agentXError("CHANNEL_REQUIRED", `${echo} is not a channel of \`${project}\`; its channels are ${list}`);
    }
    return found;
  }
  if (channels.length > 1) throw agentXError("CHANNEL_AMBIGUOUS", `project \`${project}\` has several Slack channels: ${list}`);
  return channels[0]!;
}

/** C3: undefined when the task stays private; otherwise where and how it is shared, or a refusal. */
export function decideShare(input: {
  project: string;
  policy: DeveloperTaskPolicy;
  shareToChannel: boolean;
  shareMode?: "view" | "continue";
  channel?: string;
  bound: readonly BoundChannel[];
}): ShareDecision | undefined {
  const required = input.policy.share === "required";
  if (!input.shareToChannel && !required) return undefined;
  const channel = pickChannel(input.project, input.bound, input.channel);
  const mode = decideMode(input.policy, input.shareMode ?? input.policy.shareMode.default);
  return {
    channelId: channel.channelId,
    ...(channel.name !== undefined && channel.isPrivate === false ? { channelName: channel.name } : {}),
    ...mode,
    sharedReason: input.shareToChannel ? "requested" : "required",
  };
}
