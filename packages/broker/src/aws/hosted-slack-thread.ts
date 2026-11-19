// Lead 4 L4-HW8: the lessons' Slack source on a deployed install (L4-SRC-SL, PR 1036, left `slackThreadCommand` unwired: the install has no in-process Slack adapter in the registry).
// The deployment's Slack adapter is a signed webhook one, reached the way every other core post to Slack already is: the built-in adapter record from the environment (`builtInAdapterFromEnvironment`,
// aws/channel-adapters.ts, BUILT_IN_ADAPTER_*), its signing secret read from Secrets Manager (`slackAdapterSecretReader`), and one signed command to its `/v1/slack/channel-commands` route
// (`sendChannelCommand`, aws/channel-commands.ts; the route is `createAwsSlackChannelCommandsHandler`, aws/slack-adapter.ts, which answers `thread_messages`). Nothing new is added to that path.
//
// What this makes, for ONE company at a time:
//   command   `thread_messages` and nothing else (the kind is fixed here, never taken from a caller), sent only for a Slack tenant that is THIS company's (asked of the workspace binding NOW, a failing
//             answer is "not this company's"), and answered through the contract's own schema. The reader (`core/channel/thread-replies.ts`) has already checked the task's own thread, its project's binding and
//             the tenant before it asks; this check stands behind it, so a mistake there cannot send a command for another company's workspace.
//   companyOf which company a Slack tenant (workspace) belongs to: in Slack company mode the install's workspace bindings (`requireCompany`: a bound workspace is its company's, an unbound one is nobody's);
//             otherwise the install's own team is the implicit company's and every other tenant is nobody's. Never "every tenant is yours" (the reader's default for one company), which on an install
//             of many companies would let company A ask about company B's workspace.
// Off by default and fail closed: no `SLACK_VIA_CHANNEL=enabled`, no built-in adapter with a commands URL, or an adapter that does not declare `history` gives no command, and the source reads nothing.
import { IMPLICIT_COMPANY_ID, SLACK_CHANNEL, adapterTakesCommand, type ChannelCommandInput, type ChannelCommandResult, type OrgId } from "@agentx/contracts";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { checkEndpointAddresses } from "@agentx/gateway";
import type { ChannelCompanyOf } from "../core/channel/company.js";
import { builtInAdapterFromEnvironment } from "./channel-adapters.js";
import { sendChannelCommand, type ChannelCommandDependencies } from "./channel-commands.js";
import { slackAdapterSecretReader } from "./slack-adapter.js";
import { slackWorkspaceTeam } from "./slack-workspace-binding.js";

export type SlackThreadAsk = ChannelCommandInput<"thread_messages">;
export type SlackThreadCommand = (input: SlackThreadAsk) => Promise<ChannelCommandResult<"thread_messages">>;

/** What the lessons of one company are given for Slack: which company a workspace is, and the one read command. */
export interface HostedLessonsSlack {
  companyOf: ChannelCompanyOf;
  command: SlackThreadCommand;
}

export interface HostedSlackThreadInputs {
  env: NodeJS.ProcessEnv;
  secretsManager: Pick<SecretsManagerClient, "send">;
  /** The workspace bindings of Slack company mode (`slackCompany.workspaces`), when that mode is on. */
  workspaces?: { requireCompany(teamId: string): Promise<string> } | undefined;
  /** The install's own Slack team (SLACK_TEAM_ID or SLACK_ADAPTER_TEAM_ID). */
  legacyTeamId?: string | undefined;
  /** Test seams (the real fetch, address check and clock otherwise). */
  fetch?: typeof fetch;
  checkAddresses?: ChannelCommandDependencies["checkAddresses"];
  now?: () => number;
}

/** Which company a Slack tenant belongs to, as the install knows it now. A tenant that is not a Slack team id, or nobody's, is undefined. */
export function hostedSlackCompanyOf(input: Pick<HostedSlackThreadInputs, "workspaces" | "legacyTeamId">): ChannelCompanyOf {
  return async (where) => {
    if (where === null || typeof where !== "object" || where.channel !== SLACK_CHANNEL || !slackWorkspaceTeam(where.tenant)) return undefined;
    if (input.workspaces !== undefined) {
      try { return await input.workspaces.requireCompany(where.tenant); } catch { return undefined; }
    }
    return input.legacyTeamId !== undefined && slackWorkspaceTeam(input.legacyTeamId) && where.tenant === input.legacyTeamId ? IMPLICIT_COMPANY_ID : undefined;
  };
}

/**
 * The factory the broker gives its core root (`BrokerCoreRootInputs.lessonsSlack`): `(companyId) => { companyOf, command }`, or undefined where the deployment's Slack adapter cannot be reached
 * (then lessons are built without a Slack source, as before). Building one reads nothing and sends nothing.
 */
export function hostedLessonsSlack(input: HostedSlackThreadInputs): ((companyId: OrgId) => HostedLessonsSlack) | undefined {
  if (input.env.SLACK_VIA_CHANNEL !== "enabled") return undefined;
  const adapter = builtInAdapterFromEnvironment(input.env);
  if (adapter?.commandsUrl === undefined || adapter.channel !== SLACK_CHANNEL || !adapterTakesCommand(adapter, "thread_messages")) return undefined;
  const secret = slackAdapterSecretReader(input.secretsManager, adapter.secretName);
  const deps: ChannelCommandDependencies = {
    getSecret: () => secret(), fetch: input.fetch ?? fetch, checkAddresses: input.checkAddresses ?? ((url) => checkEndpointAddresses(url)), now: input.now ?? Date.now,
  };
  const companyOf = hostedSlackCompanyOf(input);
  return (companyId) => ({
    companyOf,
    async command(asking) {
      // Behind the reader's own checks: only this company's workspace is ever sent a command.
      if (await companyOf({ channel: SLACK_CHANNEL, tenant: asking.tenant }) !== companyId) throw new Error("that Slack workspace is not this company's");
      return await sendChannelCommand(deps, adapter, "thread_messages", { tenant: asking.tenant, space: asking.space, thread: asking.thread });
    },
  });
}
