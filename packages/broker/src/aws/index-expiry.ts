// Spec 025 A6 (Q5, owner answer 2026-09-30): the failure and usage index days are kept 30 days
// (FR-038). Named environments' State table expires them by TTL; the legacy deployment's has no
// TTL (its template does not change), so there the reconciler deletes old days.
// It looks 15 days back past the retention, so a run that failed or was skipped is caught up.
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ADMIN_INDEX_RETENTION_DAYS } from "@agentx/contracts";

type Client = { send(command: unknown): Promise<unknown> };
export const INDEX_EXPIRY_DELETES_PER_RUN = 500;
export const INDEX_EXPIRY_LOOKBACK_DAYS = 15;
const DAY_MS = 86_400_000;

/** The sweep runs only where the State table has no TTL: Task 13 sets INDEX_EXPIRY=ttl in named environments. */
export function indexSweepWanted(env: NodeJS.ProcessEnv): boolean {
  return env.INDEX_EXPIRY !== "ttl";
}
const PREFIXES = ["FAILURE#", "USAGE#"] as const;

export async function expireIndexDays(client: Client, tableName: string, now: Date, log: (entry: Record<string, unknown>) => void = () => undefined): Promise<{ deleted: number }> {
  let deleted = 0;
  for (let back = ADMIN_INDEX_RETENTION_DAYS + 1; back <= ADMIN_INDEX_RETENTION_DAYS + INDEX_EXPIRY_LOOKBACK_DAYS; back += 1) {
    const day = new Date(now.getTime() - back * DAY_MS).toISOString().slice(0, 10);
    for (const prefix of PREFIXES) {
      if (deleted >= INDEX_EXPIRY_DELETES_PER_RUN) break;
      const response = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :day)",
        ExpressionAttributeValues: { ":pk": `${prefix}${day}`, ":day": day },
        Limit: INDEX_EXPIRY_DELETES_PER_RUN - deleted,
      })) as { Items?: Array<{ pk: string; sk: string }> };
      for (const entry of response.Items ?? []) {
        await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: entry.pk, sk: entry.sk } }));
        deleted += 1;
      }
    }
  }
  // A count only: the items hold errors and names.
  if (deleted > 0) log({ event: "index_expiry.deleted", deleted });
  return { deleted };
}
