// Spec 062 Phase 7c1b: the Slack directory's reads through the built-in Slack adapter. The directory keeps its own
// rules (caches, call budgets, who is eligible); each Web API read it makes becomes one neutral directory command, and
// the adapter's answer is given back in the shape Slack's answer had. A refusal carries the adapter's code; no answer
// throws, which the directory counts as Slack being unreachable.
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { ChannelAdapterRecord, ChannelCommandKind, ChannelCommandResult, DirectoryUser } from "@agentx/contracts";
import { checkEndpointAddresses } from "@agentx/gateway";
import { builtInAdapterFromEnvironment } from "./channel-adapters.js";
import { ChannelCommandFailed, sendChannelCommand, type ChannelCommandDependencies, type ChannelCommandInput } from "./channel-commands.js";
import { slackAdapterSecretReader } from "./slack-adapter.js";

type Call = (method: string, query: Record<string, string>, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;

/** A directory person as Slack's users.info shows them, with only the fields the directory reads. */
function slackUserOf(user: DirectoryUser): Record<string, unknown> {
  return {
    id: user.userId,
    ...(user.tenant === undefined ? {} : { team_id: user.tenant }),
    deleted: user.deleted,
    is_bot: user.bot,
    ...(user.external === undefined ? {} : { is_stranger: user.external }),
    ...(user.name === undefined ? {} : { name: user.name }),
    profile: { ...(user.displayName === undefined ? {} : { display_name: user.displayName }), ...(user.realName === undefined ? {} : { real_name: user.realName }) },
    ...(user.linkedTenants === undefined ? {} : { enterprise_user: { teams: user.linkedTenants } }),
  };
}

export function slackDirectoryCall(deps: ChannelCommandDependencies & { adapter: ChannelAdapterRecord; teamId: string }): Call {
  const ok = (body: Record<string, unknown>) => ({ status: 200, body: { ok: true, ...body } });
  const refusal = (error: string) => ({ status: 200, body: { ok: false, error } });
  return async (method, query, signal) => {
    const send = <K extends ChannelCommandKind>(kind: K, input: ChannelCommandInput<K>): Promise<ChannelCommandResult<K>> =>
      sendChannelCommand(deps, deps.adapter, kind, input, { signal });
    try {
      switch (method) {
        case "users.info": {
          const { user } = await send("user", { tenant: deps.teamId, userId: query.user ?? "" });
          return user === undefined ? refusal("user_not_found") : ok({ user: slackUserOf(user) });
        }
        case "users.lookupByEmail": {
          const { user } = await send("user_by_email", { tenant: deps.teamId, email: query.email ?? "" });
          return user === undefined ? refusal("users_not_found") : ok({ user: slackUserOf(user) });
        }
        case "conversations.members": {
          const page = await send("space_members", { tenant: deps.teamId, space: query.channel ?? "", ...(query.cursor === undefined ? {} : { cursor: query.cursor }) });
          return ok({ members: page.members, response_metadata: { next_cursor: page.nextCursor ?? "" } });
        }
        case "conversations.info": {
          const { space } = await send("space", { tenant: deps.teamId, space: query.channel ?? "" });
          return space === undefined ? refusal("channel_not_found") : ok({ channel: { name: space.name, is_private: space.private } });
        }
        case "conversations.list": {
          const page = await send("spaces", { tenant: deps.teamId, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) });
          return ok({ channels: page.spaces.map((entry) => ({ id: entry.space, name: entry.name, is_private: entry.private })), response_metadata: { next_cursor: page.nextCursor ?? "" } });
        }
        case "auth.test":
          return ok({ team_id: (await send("check", {})).tenant });
        default:
          throw new Error(`the Slack adapter has no directory read for ${method}`);
      }
    } catch (error) {
      // Refused: the adapter did nothing and said why; the directory reports the code and counts Slack unavailable.
      if (error instanceof ChannelCommandFailed && error.outcome === "refused") return refusal(error.adapterCode ?? "refused");
      throw error;
    }
  };
}

/** The directory's reads through the adapter when Slack goes through the channel API; otherwise undefined. */
export function slackDirectoryCallFromEnvironment(secretsManager: Pick<SecretsManagerClient, "send">): Call | undefined {
  if (process.env.SLACK_VIA_CHANNEL !== "enabled") return undefined;
  const adapter = builtInAdapterFromEnvironment(process.env);
  const teamId = process.env.SLACK_ADAPTER_TEAM_ID;
  if (adapter?.commandsUrl === undefined || !teamId || !/^[TE][A-Z0-9]{2,31}$/.test(teamId)) {
    console.log(JSON.stringify({ component: "slack-directory-channel", event: "not_configured" }));
    return undefined;
  }
  const secret = slackAdapterSecretReader(secretsManager, adapter.secretName);
  return slackDirectoryCall({ adapter, teamId, getSecret: () => secret(), fetch, checkAddresses: (url) => checkEndpointAddresses(url), now: Date.now });
}

