// Revision authority reads deliberately exclude lifecycle META: the dispatcher has a bounded read budget.
// Registration/settlement still compare the retained incarnation transactionally; lifecycle callers use company-layout.ts.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { PROJECT_REVISION_SK_PREFIX, ProjectDefinitionSchema, orgProjectCatalogKey, projectPk, projectRevisionKey, type OrgId } from "@agentx/contracts";
import { ownPartitionRow } from "./company-check.js";

type Client = { send(command: unknown): Promise<unknown> };
type Key = { pk: string; sk: string };

/** Company catalogue pointer, else the newest non-candidate revision; every read stays on this company's keys. */
export async function readNamedCompanyRevisionRow(client: Client, tableName: string, company: OrgId, project: string): Promise<Record<string, unknown> | undefined> {
  const pk = projectPk(company, project);
  const usable = (row: Record<string, unknown> | undefined) =>
    row !== undefined && row.pk === pk && ownPartitionRow(row, company) && ProjectDefinitionSchema.safeParse(row.definition).success
    && typeof (row.definition as { revision?: unknown }).revision === "number" ? row : undefined;
  const get = async (key: Key) => (await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined)?.Item;
  const catalogKey = orgProjectCatalogKey(company, project);
  const catalog = await get(catalogKey);
  const pointer = catalog?.latestRevision;
  if (catalog !== undefined && catalog.pk === catalogKey.pk && catalog.sk === catalogKey.sk && typeof pointer === "number" && Number.isSafeInteger(pointer) && pointer > 0) {
    const named = usable(await get(projectRevisionKey(company, project, pointer)));
    if (named !== undefined) return named;
  }
  const response = await client.send(new QueryCommand({
    TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
    ExpressionAttributeValues: { ":pk": pk, ":rev": PROJECT_REVISION_SK_PREFIX }, ScanIndexForward: false, Limit: 20, ConsistentRead: true,
  })) as { Items?: Array<Record<string, unknown>> } | undefined;
  return usable((response?.Items ?? []).find((item) => item.candidate !== true));
}
