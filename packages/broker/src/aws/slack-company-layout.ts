// DEC 254zzz80 (R2-F1): the Slack channel-binding half of the company layout (moved out of company-layout.ts unchanged, batch b21, so the Slack boundary guard's
// count of non-Slack modules importing Slack names stays at its cap). A NAMED company's bindings live in its own partition (`ORG#<c>#SLACK_BINDING#<team>`);
// the built-in company and a Code with no company keep the legacy `SLACK_BINDING#<team>` keys.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  ChannelSpaceRefSchema, channelBindingKey, channelBindingPartition, slackBindingPk, SLACK_CHANNEL, SlackChannelBindingSchema, readChannelBindingItem, slackBindingKey, slackBindingOf, type OrgId, type SlackChannelBinding,
} from "@agentx/contracts";
import { ownPartitionRow } from "./company-check.js";
import { namedCompany } from "./company-layout.js";

type Client = { send(command: unknown): Promise<unknown> };
type Key = { pk: string; sk: string };

/** The partition of a Slack team's channel bindings for this company: a NAMED company's own (`ORG#<c>#SLACK_BINDING#<team>`), else the legacy `SLACK_BINDING#<team>`. */
export function slackChannelBindingPkFor(companyId: string | undefined, teamId: string): string {
  const company = namedCompany(companyId);
  return company === undefined ? channelBindingPartition(SLACK_CHANNEL, teamId) : slackBindingPk(company, teamId);
}

/** One Slack channel's binding key for this company (the ref is checked as the legacy key checks it). */
export function slackChannelBindingKeyFor(companyId: string | undefined, teamId: string, channelId: string): Key {
  const legacy = channelBindingKey({ channel: SLACK_CHANNEL, tenant: teamId, space: channelId });
  const company = namedCompany(companyId);
  return company === undefined ? legacy : slackBindingKey(company, teamId, channelId);
}

/**
 * A Slack channel's binding for a NAMED company, from the company's own partition only: `ORG#<company>#SLACK_BINDING#<team>` / `CHANNEL#<channel>` (slackBindingKey). Absent when
 * there is no row. A row whose key is not exactly that key, that names another team or channel, that names another company, or that does not parse, is absent too (never a guess,
 * never another company's row). The result names the company it was read for, so a caller can tell a company-scoped binding from a legacy one.
 */
export async function namedCompanySlackBinding(client: Client, tableName: string, company: OrgId, teamId: string, channelId: string): Promise<(SlackChannelBinding & { companyId: OrgId }) | undefined> {
  if (namedCompany(company) !== company) return undefined;
  const ref = { channel: SLACK_CHANNEL, tenant: teamId, space: channelId };
  if (!ChannelSpaceRefSchema.safeParse(ref).success) return undefined;
  const key: Key = slackChannelBindingKeyFor(company, teamId, channelId);
  const response = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined;
  const row = response?.Item;
  if (row === undefined || row.pk !== key.pk || row.sk !== key.sk || !ownPartitionRow(row, company)) return undefined;
  try {
    const binding = slackBindingOf(readChannelBindingItem(ref, row)!);
    return SlackChannelBindingSchema.safeParse(binding).success ? { ...binding, companyId: company } : undefined;
  } catch { return undefined; }
}

/**
 * Whether a Slack channel binding row sits at its key for this company (R2-F1 review round 3): a NAMED company's own `ORG#<company>#SLACK_BINDING#<team>` /
 * `CHANNEL#<channel>`, else the legacy key exactly as `isChannelBindingKeyOf` checks it. A team or channel that is not a valid ref never matches.
 */
export function slackChannelBindingKeyMatches(item: { pk?: unknown; sk?: unknown }, companyId: string | undefined, teamId: string, channelId: string): boolean {
  if (!ChannelSpaceRefSchema.safeParse({ channel: SLACK_CHANNEL, tenant: teamId, space: channelId }).success) return false;
  const key = slackChannelBindingKeyFor(companyId, teamId, channelId);
  return item.pk === key.pk && item.sk === key.sk;
}
