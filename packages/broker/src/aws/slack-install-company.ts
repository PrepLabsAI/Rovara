// DEC 254: the Slack part of the install's company-scoped records (install-company.ts): one company's channel bindings for the install's own Slack team,
// `ORG#<company>#SLACK_BINDING#<team>` / `CHANNEL#<channel>`. Kept beside the other Slack modules (the Slack boundary, spec 062 SC-004).
import { SLACK_BINDING_SK_PREFIX, slackBindingPk, type OrgId, type SlackChannelBinding } from "@agentx/contracts";
import { installCompanyQuery } from "./install-company.js";

/** The install's Slack team's channel bindings inside one company, read under the company's own partition. */
export async function installCompanyBindings(client: { send(command: unknown): Promise<unknown> }, tableName: string, companyId: OrgId, teamId: string): Promise<SlackChannelBinding[]> {
  const rows = await installCompanyQuery(client, tableName, slackBindingPk(companyId, teamId), SLACK_BINDING_SK_PREFIX);
  return rows.flatMap((row) => typeof row.projectName === "string" && typeof row.channelId === "string" && row.sk === `${SLACK_BINDING_SK_PREFIX}${row.channelId}`
    ? [{ ...(row as unknown as SlackChannelBinding), teamId: typeof row.teamId === "string" ? row.teamId : teamId }] : []);
}
