// #651: counts on their tasks the usage recorded before tasks kept a spend total. It reads the usage index (`USAGE#<day>`, kept 30 days) and counts each
// record through the same writer the activity index uses, under the same id (`<at in ms>_<operationId>`), so a record the activity index already counted
// is skipped and running this twice changes nothing.
//
//   AWS_REGION=us-east-1 STATE_TABLE_NAME=<state table> npx tsx scripts/backfill-task-spend.ts [--days 30] [--dry-run]
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { taskUsageWriter } from "../packages/broker/src/aws/outbox-publisher.js";

const DAY_MS = 86_400_000;

export interface BackfillResult { records: number; counted: number; skipped: number }

/** Counts every usage record of the last `days` days that names a task. Returns how many it read, sent to be counted, and skipped (no task, unreadable). */
export async function backfillTaskSpend(client: Pick<DynamoDBDocumentClient, "send">, table: string, options: { days: number; now?: number; dryRun?: boolean }): Promise<BackfillResult> {
  const write = taskUsageWriter(client, () => table);
  const now = options.now ?? Date.now();
  const result: BackfillResult = { records: 0, counted: 0, skipped: 0 };
  // Oldest day first, each in time order (the sort key starts with the time), so each task's spentUpdatedAt ends at its newest record, as the live path leaves it.
  for (let day = options.days - 1; day >= 0; day -= 1) {
    const pk = `USAGE#${new Date(now - day * DAY_MS).toISOString().slice(0, 10)}`;
    let start: Record<string, unknown> | undefined;
    do {
      const page = await client.send(new QueryCommand({ TableName: table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ScanIndexForward: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }) })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of page.Items ?? []) {
        result.records += 1;
        const { taskId, operationId, at } = item;
        if (typeof taskId !== "string" || typeof operationId !== "string" || typeof at !== "string" || Number.isNaN(Date.parse(at))) { result.skipped += 1; continue; }
        if (options.dryRun !== true) {
          await write(taskId, `${String(Date.parse(at))}_${operationId}`, {
            at, usd: typeof item.costUsd === "number" ? item.costUsd : null,
            inputTokens: typeof item.inputTokens === "number" ? item.inputTokens : 0, outputTokens: typeof item.outputTokens === "number" ? item.outputTokens : 0,
          });
        }
        result.counted += 1;
      }
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
  }
  return result;
}

async function main(argv: string[]): Promise<void> {
  const table = process.env.STATE_TABLE_NAME;
  if (table === undefined || table === "") throw new Error("STATE_TABLE_NAME is required");
  const daysAt = argv.indexOf("--days");
  const days = daysAt === -1 ? 30 : Number(argv[daysAt + 1]);
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error("--days must be a whole number from 1 to 60");
  const client = DynamoDBDocumentClient.from(new DynamoDBClient(process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION }));
  const result = await backfillTaskSpend(client, table, { days, dryRun: argv.includes("--dry-run") });
  console.log(JSON.stringify({ event: "task_spend.backfill", days, dryRun: argv.includes("--dry-run"), ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
