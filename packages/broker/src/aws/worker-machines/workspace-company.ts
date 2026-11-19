import { logWorkspacePointerIntegrity } from "../../core/task-flow/workspace-pointer.js";
// Engine host (lane E2, step 4): whose a workspace is, for the EC2 machines adapter and the core dispatch host. Read on every call, strongly consistent.
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, agentXError, type OrgId } from "@agentx/contracts";
import { workspaceKey } from "../../core/task-flow/keys.js";

type Reader = Pick<DynamoDBDocumentClient, "send">;

async function readItem(documentClient: Reader, tableName: string, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  return ((await documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
}

/**
 * The company of `WORKSPACE#<id>/META`: the record's `companyId` (the core writes it on every workspace). One Code install serves every company, so there is no install-wide fallback: a record
 * without a valid `companyId` is nobody's. When the record also carries `orgId`, it must name the same company. Undefined (nobody's) when there is no such workspace, when a field is not a
 * company id, or when the two differ. A thin discovery pointer additionally requires its scoped workspace to name the same company.
 */
export function workspaceCompanyReader(documentClient: Reader, tableName: string): (workspaceId: string) => Promise<OrgId | undefined> {
  return async (workspaceId) => {
    const item = await readItem(documentClient, tableName, workspaceMetaKey(workspaceId));
    const company = companyOfWorkspaceItem(item);
    if (item?.["entityType"] !== "WORKSPACE_COMPANY_POINTER") return company;
    if (company === undefined) { logWorkspacePointerIntegrity(); return undefined; }
    const scoped = await readItem(documentClient, tableName, workspaceKey(company, workspaceId));
    if (companyOfWorkspaceItem(scoped) === company) return company;
    logWorkspacePointerIntegrity();
    return undefined;
  };
}

const workspaceMetaKey = (workspaceId: string) => ({ pk: `WORKSPACE#${workspaceId}`, sk: "META" });

function companyOfWorkspaceItem(item: Record<string, unknown> | undefined): OrgId | undefined {
  if (item === undefined) return undefined;
  const company = OrgIdSchema.safeParse(item["companyId"]);
  if (!company.success) return undefined;
  if (item["orgId"] !== undefined && item["orgId"] !== company.data) return undefined;
  return company.data;
}

/** Shared AWS lifecycle reads need the workspace's fields and its stable write key, never the discovery row's fields. */
export async function readWorkspaceMeta(documentClient: { send(command: GetCommand): Promise<unknown> }, tableName: string, workspaceId: string): Promise<{ key: { pk: string; sk: string }; item: Record<string, unknown> } | undefined> {
  const read = async (key: { pk: string; sk: string }) => ((await documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  const legacyKey = workspaceMetaKey(workspaceId);
  const discovery = await read(legacyKey);
  if (discovery === undefined) return undefined;
  if (discovery["entityType"] !== "WORKSPACE_COMPANY_POINTER") return { key: legacyKey, item: discovery };
  const company = companyOfWorkspaceItem(discovery);
  if (company !== undefined) {
    const key = workspaceKey(company, workspaceId);
    const item = await read(key);
    if (item !== undefined && companyOfWorkspaceItem(item) === company && item["entityType"] !== "WORKSPACE_COMPANY_POINTER") return { key, item };
  }
  logWorkspacePointerIntegrity();
  throw agentXError("NOT_FOUND", "workspace unavailable");
}
