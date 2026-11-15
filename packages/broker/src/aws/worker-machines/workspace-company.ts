// Engine host (lane E2, step 4): whose a workspace is, for the EC2 machines adapter and the core dispatch host. Read on every call, strongly consistent.
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, type OrgId } from "@agentx/contracts";

type Reader = Pick<DynamoDBDocumentClient, "send">;

async function readItem(documentClient: Reader, tableName: string, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  return ((await documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
}

/**
 * The company of `WORKSPACE#<id>/META`: the record's `companyId` (the core writes it on every workspace). One Code install serves every company, so there is no install-wide fallback: a record
 * without a valid `companyId` is nobody's. When the record also carries `orgId`, it must name the same company. Undefined (nobody's) when there is no such workspace, when a field is not a
 * company id, or when the two differ.
 */
export function workspaceCompanyReader(documentClient: Reader, tableName: string): (workspaceId: string) => Promise<OrgId | undefined> {
  return async (workspaceId) => companyOfWorkspaceItem(await readItem(documentClient, tableName, workspaceMetaKey(workspaceId)));
}

const workspaceMetaKey = (workspaceId: string) => ({ pk: `WORKSPACE#${workspaceId}`, sk: "META" });

function companyOfWorkspaceItem(item: Record<string, unknown> | undefined): OrgId | undefined {
  if (item === undefined) return undefined;
  const company = OrgIdSchema.safeParse(item["companyId"]);
  if (!company.success) return undefined;
  if (item["orgId"] !== undefined && item["orgId"] !== company.data) return undefined;
  return company.data;
}
