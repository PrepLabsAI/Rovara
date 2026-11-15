// #661: a task keeps its owner's name (`developerName`, copied when it started) and every reader shows that copy: the task view, the task page, Slack and
// Rovara Cloud. When a person's name changes, their tasks take the new one, so a name chosen later (or a placeholder fixed) shows on tasks already started.
import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** The most tasks one rename updates; a person with more keeps the old name on the oldest. */
export const OWNER_RENAME_TASKS_MAX = 1_000;

/**
 * Sets `developerName` on the tasks `developerId` started (their `DEVELOPER#<id>` / `TASK#` index), each only while the task is still theirs and still
 * exists. Returns how many it read and changed. A task that already has the name is written again with the same value, which changes nothing.
 */
export async function renameTaskOwner(client: Pick<DynamoDBDocumentClient, "send">, table: string, developerId: string, name: string): Promise<{ tasks: number; renamed: number }> {
  const taskIds: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new QueryCommand({
      TableName: table, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `DEVELOPER#${developerId}`, ":prefix": "TASK#" }, ProjectionExpression: "taskId",
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ taskId?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) if (typeof item.taskId === "string" && taskIds.length < OWNER_RENAME_TASKS_MAX) taskIds.push(item.taskId);
    start = taskIds.length >= OWNER_RENAME_TASKS_MAX ? undefined : page.LastEvaluatedKey;
  } while (start !== undefined);
  let renamed = 0;
  for (const taskId of [...new Set(taskIds)]) {
    try {
      await client.send(new UpdateCommand({
        TableName: table, Key: { pk: `DEVTASK#${taskId}`, sk: "META" },
        ConditionExpression: "attribute_exists(pk) AND developerId = :developer AND developerName <> :name",
        UpdateExpression: "SET developerName = :name", ExpressionAttributeValues: { ":developer": developerId, ":name": name },
      }));
      renamed += 1;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
    }
  }
  return { tasks: taskIds.length, renamed };
}
