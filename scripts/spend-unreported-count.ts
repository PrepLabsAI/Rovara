// SPEND-UNREPORTED-RUN item 4: a READ-ONLY count of the tasks whose spend is stuck unreadable because an ENDED model run sent no usage report, and which of the three settle cases each such run would get
// (gateway_record, no_call, estimate; core-host/unreported-run-settle.ts). It writes nothing: only Scan, Query and Get are used (a test pins that no write command is imported here). The settling itself is
// not run from here: it happens on the next read of the task's spend (the Approve check, automatic fixing) and is never a manual write.
//
//   node scripts/spend-unreported-count.ts --table <state table> [--region <r>] [--profile <p>] [--company <org id>]
//
// Beta only through the beta read-only wrapper; production only by the owner or the production session. Output: one JSON line per company, then a total line.
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, type DocumentStore } from "../packages/contracts/src/index.js";
import { countUnreportedRuns, type UnreportedCount } from "../packages/broker/src/core-host/unreported-run-settle.js";

interface Options { table: string; region?: string; profile?: string; company?: string }

export function parseArguments(argv: readonly string[]): Options | string {
  const options: Partial<Options> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!, value = argv[index + 1];
    if (flag === "--table" || flag === "--region" || flag === "--profile" || flag === "--company") {
      if (value === undefined || value.startsWith("--")) return `${flag} needs a value`;
      options[flag.slice(2) as "table" | "region" | "profile" | "company"] = value;
      index += 1;
    } else return `Unknown option ${flag}. Usage: node scripts/spend-unreported-count.ts --table <state table> [--region <r>] [--profile <p>] [--company <org id>]`;
  }
  if (options.table === undefined) return "--table is required";
  if (options.company !== undefined && !OrgIdSchema.safeParse(options.company).success) return "--company is not a company id";
  return options as Options;
}

/** The two reads the count needs, over DynamoDB: a strongly consistent get and a one-partition query. Nothing else is implemented, so nothing can write through it. */
export function readOnlyStore(client: DynamoDBDocumentClient, table: string): DocumentStore {
  const refused = async (): Promise<never> => { throw new Error("this store is read-only"); };
  const reader: Pick<DocumentStore, "indexes" | "get" | "query"> = {
    indexes: [],
    get: async (key) => (await client.send(new GetCommand({ TableName: table, Key: { pk: key.pk, sk: key.sk }, ConsistentRead: true }))).Item as never,
    query: async (request) => {
      const prefix = request.sk !== undefined && "op" in request.sk && request.sk.op === "beginsWith" ? request.sk.prefix : undefined;
      const page = await client.send(new QueryCommand({
        TableName: table, ConsistentRead: true, Limit: request.limit,
        KeyConditionExpression: prefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": request.pk, ...(prefix === undefined ? {} : { ":prefix": prefix }) },
        ...(request.cursor === undefined ? {} : { ExclusiveStartKey: JSON.parse(request.cursor) as Record<string, unknown> }),
      }));
      return { items: (page.Items ?? []) as never, ...(page.LastEvaluatedKey === undefined ? {} : { cursor: JSON.stringify(page.LastEvaluatedKey) }) };
    },
  };
  return { ...reader, getMany: refused, put: refused, update: refused, delete: refused, queryIndex: refused, transact: refused };
}

/** The ids of every task row of the table, by company (a Scan, read only). */
async function* taskIdsByCompany(client: DynamoDBDocumentClient, table: string): AsyncGenerator<{ companyId: string; taskId: string }> {
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({ TableName: table, FilterExpression: "entityType = :t", ExpressionAttributeValues: { ":t": "DEVELOPER_TASK" }, ProjectionExpression: "taskId, companyId", ...(start === undefined ? {} : { ExclusiveStartKey: start }) }));
    for (const item of page.Items ?? []) if (typeof item["taskId"] === "string" && typeof item["companyId"] === "string") yield { companyId: item["companyId"], taskId: item["taskId"] };
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  if (typeof options === "string") { console.error(options); return 2; }
  // The SDK's own credential chain reads the profile from the environment.
  if (options.profile !== undefined) process.env["AWS_PROFILE"] = options.profile;
  const client = DynamoDBDocumentClient.from(new DynamoDBClient(options.region === undefined ? {} : { region: options.region }));
  const byCompany = new Map<string, string[]>();
  for await (const { companyId, taskId } of taskIdsByCompany(client, options.table)) {
    if ((options.company !== undefined && companyId !== options.company) || !OrgIdSchema.safeParse(companyId).success) continue;
    byCompany.set(companyId, [...(byCompany.get(companyId) ?? []), taskId]);
  }
  const store = readOnlyStore(client, options.table);
  const total: UnreportedCount = { tasks: 0, running: 0, unreadable: 0, clean: 0, stuck: 0, runs: { gateway_record: 0, no_call: 0, estimate: 0, kept_unbooked: 0 } };
  for (const [companyId, taskIds] of byCompany) {
    const count = await countUnreportedRuns(store, companyId, taskIds);
    console.log(JSON.stringify({ companyId, ...count }));
    for (const key of ["tasks", "running", "unreadable", "clean", "stuck"] as const) total[key] += count[key];
    for (const key of Object.keys(total.runs) as Array<keyof UnreportedCount["runs"]>) total.runs[key] += count.runs[key];
  }
  console.log(JSON.stringify({ total }));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));
