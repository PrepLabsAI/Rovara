// #661: gives tasks started before a name change their owner's current name. For each registered, not revoked person in the sign-in table, it sets
// that person's current `displayName` on the tasks they started (renameTaskOwner, the same step a rename runs). Only differing names are written, so
// running it again changes nothing.
//
//   AWS_REGION=us-east-1 SIGNIN_TABLE_NAME=<sign-in table> STATE_TABLE_NAME=<state table> npx tsx scripts/refresh-task-owner-names.ts [--developer <id>]
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { renameTaskOwner } from "../packages/broker/src/developer/task-owner-name.js";

export interface RefreshResult { people: number; tasks: number; renamed: number }

type Person = { pk?: unknown; displayName?: unknown; revoked?: unknown };

/** Every `DEVELOPER#<id>` / `META` row of the sign-in table, page by page. */
export async function* signInPeople(client: Pick<DynamoDBDocumentClient, "send">, table: string): AsyncGenerator<Person> {
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({
      TableName: table, FilterExpression: "begins_with(pk, :developer) AND sk = :meta",
      ExpressionAttributeValues: { ":developer": "DEVELOPER#", ":meta": "META" }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Person[]; LastEvaluatedKey?: Record<string, unknown> };
    yield* page.Items ?? [];
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
}

/** Applies every registered, not revoked person's current name (or only `only`'s) to their tasks. */
export async function refreshTaskOwnerNames(client: Pick<DynamoDBDocumentClient, "send">, state: string, people: AsyncIterable<Person> | Iterable<Person>, only?: string): Promise<RefreshResult> {
  const result: RefreshResult = { people: 0, tasks: 0, renamed: 0 };
  for await (const person of people) {
    const developerId = typeof person.pk === "string" ? person.pk.slice("DEVELOPER#".length) : "";
    if (!/^[a-f0-9]{64}$/u.test(developerId) || person.revoked === true || typeof person.displayName !== "string" || person.displayName.trim() === "") continue;
    if (only !== undefined && developerId !== only) continue;
    const renamed = await renameTaskOwner(client, state, developerId, person.displayName);
    result.people += 1;
    result.tasks += renamed.tasks;
    result.renamed += renamed.renamed;
  }
  return result;
}

async function main(argv: string[]): Promise<void> {
  const signIn = process.env.SIGNIN_TABLE_NAME, state = process.env.STATE_TABLE_NAME;
  if (!signIn || !state) throw new Error("SIGNIN_TABLE_NAME and STATE_TABLE_NAME are required");
  const at = argv.indexOf("--developer");
  const only = at === -1 ? undefined : argv[at + 1];
  if (only !== undefined && !/^[a-f0-9]{64}$/u.test(only)) throw new Error("--developer must be a developer id (64 hex characters)");
  const client = DynamoDBDocumentClient.from(new DynamoDBClient(process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION }));
  console.log(JSON.stringify({ event: "task_owner_names.refresh", ...(only === undefined ? {} : { developer: only }), ...await refreshTaskOwnerNames(client, state, signInPeople(client, signIn), only) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
