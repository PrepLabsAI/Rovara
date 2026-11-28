// #1612: the install's own company, for the CLI's init and upgrade (operator-run, with the operator's own AWS credentials).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { IMPLICIT_COMPANY_ID, OrgIdSchema } from "@agentx/contracts";
export { CompanySignInStore } from "./developer/company-membership.js";
export { InstallCompanyStore } from "./developer/install-company.js";
export { moveIntoInstallCompany, type InstallMoveReport } from "./aws/install-company-move.js";
export { moveInstallConnections, type InstallConnectionsReport } from "./aws/install-company-connections.js";

/** The operator's DynamoDB client for the install company step, in the environment's region. */
export function installCompanyClient(region: string): { send(command: unknown): Promise<unknown> } {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
}

/** The named company the install's Slack workspace is bound to, if any: the company an operator already moved the install into (#1300). */
export async function slackWorkspaceNamedCompany(client: { send(command: unknown): Promise<unknown> }, stateTable: string, teamId: string): Promise<string | undefined> {
  const answer = await client.send(new GetCommand({ TableName: stateTable, Key: { pk: `SLACK_TEAM#${teamId}`, sk: "BINDING" }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const companyId = OrgIdSchema.safeParse(answer.Item?.["companyId"]);
  return companyId.success && companyId.data !== IMPLICIT_COMPANY_ID ? companyId.data : undefined;
}
