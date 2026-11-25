// Revision authority reads deliberately exclude lifecycle META: the dispatcher has a bounded read budget.
// Registration/settlement still compare the retained incarnation transactionally; lifecycle callers use company-layout.ts.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { PROJECT_REVISION_SK_PREFIX, ProjectRevisionUnreadableError, orgProjectCatalogKey, projectPk, projectRevisionKey, readStoredProject, type OrgId } from "@agentx/contracts";
import { ownPartitionRow } from "./company-check.js";

type Client = { send(command: unknown): Promise<unknown> };
type Key = { pk: string; sk: string };

/**
 * Company catalogue pointer, else the newest non-candidate revision; every read stays on this company's keys. The revision the catalogue names is THE revision: when it is missing or does not read it is refused
 * (`ProjectRevisionUnreadableError`), never replaced by the newest older row (arch rule 9). A row that is not this company's (another company's, or another partition) is absent.
 * Without a pointer the newest non-candidate row is the project's latest by definition; one that does not read is refused the same way.
 */
export async function readNamedCompanyRevisionRow(client: Client, tableName: string, company: OrgId, project: string): Promise<Record<string, unknown> | undefined> {
  const pk = projectPk(company, project);
  const own = (row: Record<string, unknown> | undefined) => row !== undefined && row.pk === pk && ownPartitionRow(row, company);
  const readable = (row: Record<string, unknown>) => readStoredProject(row.definition).success && typeof (row.definition as { revision?: unknown }).revision === "number";
  const get = async (key: Key) => (await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined)?.Item;
  const catalogKey = orgProjectCatalogKey(company, project);
  const catalog = await get(catalogKey);
  const pointer = catalog?.latestRevision;
  if (catalog !== undefined && catalog.pk === catalogKey.pk && catalog.sk === catalogKey.sk && typeof pointer === "number" && Number.isSafeInteger(pointer) && pointer > 0) {
    const named = await get(projectRevisionKey(company, project, pointer));
    if (named === undefined) throw new ProjectRevisionUnreadableError();
    if (!own(named)) return undefined;
    if (!readable(named)) throw new ProjectRevisionUnreadableError();
    return named;
  }
  const response = await client.send(new QueryCommand({
    TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
    ExpressionAttributeValues: { ":pk": pk, ":rev": PROJECT_REVISION_SK_PREFIX }, ScanIndexForward: false, Limit: 20, ConsistentRead: true,
  })) as { Items?: Array<Record<string, unknown>> } | undefined;
  const newest = (response?.Items ?? []).find((item) => item.candidate !== true);
  if (!own(newest)) return undefined;
  if (!readable(newest!)) throw new ProjectRevisionUnreadableError();
  return newest;
}
