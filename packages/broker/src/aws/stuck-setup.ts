// Spec 025 FR-055, D21, C17: a developer task's setup never stays in PREPARING for good. The start
// writes a watch; each reconciler run fails a watched prepare still live 50 minutes after it
// started, whatever the instance's health, and drops every other old watch. Slack thread setups are
// never watched (Q4), so the sweep never touches them.
//
// F17: the sweep runs in every reconciler, the legacy one included. There no developer task starts,
// so the SETUP_WATCH partition stays empty and each run costs one empty read. The State table and
// the legacy template are unchanged (no TTL, no new grant: the reconciler already reads and writes
// the table).
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { taskPointerKey } from "../developer/task-records.js";

type Client = { send(command: unknown): Promise<unknown> };

/** Owner decision, 2026-09-29: raised from 15 minutes because the instance provisioner allows 45. */
export const STUCK_SETUP_MS = 50 * 60_000;
export const STUCK_SETUP_MESSAGE = "setup did not finish within 50 minutes; close this task and start a new one";
export const SETUP_WATCH_PK = "SETUP_WATCH";
/**
 * Watches read per run: one page. The oldest come first, so a larger backlog clears over the next
 * runs, every 10 minutes. A kept watch (a racing result) is dropped by the next run.
 */
const SWEEP_PAGE = 100;
const LIVE = ["ACCEPTED", "DISPATCHING", "RUNNING", "CANCEL_REQUESTED"];

/** The watch's key: sorted by the prepare's creation, so "older than" is one key range. */
export const setupWatchKey = (createdAt: string, workspaceId: string) => ({ pk: SETUP_WATCH_PK, sk: `${createdAt}#${workspaceId}` });

interface SetupWatch { pk: string; sk: string; workspaceId: string; operationId: string; taskId: string }

export async function sweepStuckSetups(
  client: Client,
  tableName: string,
  now: Date,
  log: (entry: Record<string, unknown>) => void = () => undefined,
): Promise<{ failed: string[]; dropped: number; kept: number }> {
  const cutoff = new Date(now.getTime() - STUCK_SETUP_MS).toISOString();
  const response = await client.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "pk = :pk AND sk < :cutoff",
    ExpressionAttributeValues: { ":pk": SETUP_WATCH_PK, ":cutoff": cutoff },
    ConsistentRead: true,
    Limit: SWEEP_PAGE,
  })) as { Items?: SetupWatch[] };
  const failed: string[] = [];
  let dropped = 0;
  let kept = 0;
  for (const watch of response.Items ?? []) {
    const outcome = await settle(client, tableName, watch, now.toISOString());
    if (outcome === "failed") {
      failed.push(watch.workspaceId);
      // The one log line per failed setup. IDs only: never the task's instructions or an error's message.
      log({ event: "stuck_setup.failed", workspaceId: watch.workspaceId, taskId: watch.taskId, operationId: watch.operationId });
    } else if (outcome === "dropped") {
      dropped += 1;
    } else {
      kept += 1;
    }
  }
  return { failed, dropped, kept };
}

/**
 * Fails the watched prepare if it is still the workspace's live operation, else drops the watch.
 * "kept": a result landed during the failing transaction, which cancelled; the watch stays.
 * The failure commits only while the operation is still in progress under the same fence, so a
 * result that lands first stands, and a second run finds nothing to do.
 */
async function settle(client: Client, tableName: string, watch: SetupWatch, now: string): Promise<"failed" | "dropped" | "kept"> {
  const workspaceKey = { pk: `WORKSPACE#${watch.workspaceId}` };
  const get = async (sk: string) => ((await client.send(new GetCommand({ TableName: tableName, Key: { ...workspaceKey, sk }, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  const [workspace, operation] = await Promise.all([get("META"), get(`OPERATION#${watch.operationId}`)]);
  const drop = { TableName: tableName, Key: { pk: watch.pk, sk: watch.sk } };
  const live = operation?.kind === "prepare" && LIVE.includes(String(operation.status));
  if (workspace?.status !== "PREPARING" || workspace.activeOperationId !== watch.operationId || !live || typeof operation.fence !== "number") {
    await client.send(new DeleteCommand(drop));
    return "dropped";
  }
  try {
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName, Key: { ...workspaceKey, sk: `OPERATION#${watch.operationId}` },
        // updatedAt is required: the notifier stamps the setup-failed notice from it (ruling F7).
        UpdateExpression: "SET #status = :failed, updatedAt = :now, #error = :error",
        ConditionExpression: "(#status = :accepted OR #status = :dispatching OR #status = :running OR #status = :cancelRequested) AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: {
          ":failed": "FAILED", ":now": now, ":error": STUCK_SETUP_MESSAGE, ":fence": operation.fence,
          ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":running": "RUNNING", ":cancelRequested": "CANCEL_REQUESTED",
        },
      } },
      // As any failed developer-task prepare: the workspace reads setup_failed, and closing the task
      // frees its slot (FR-020, ruling F20). The sweep itself releases no slot.
      { Update: {
        TableName: tableName, Key: { ...workspaceKey, sk: "META" },
        UpdateExpression: "SET #status = :released, updatedAt = :now REMOVE activeOperationId, closeError",
        ConditionExpression: "activeOperationId = :operation AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":released": "PREPARATION_FAILED", ":now": now, ":operation": watch.operationId, ":fence": operation.fence },
      } },
      // FR-018: pending instructions never linger unqueued.
      { Update: {
        TableName: tableName, Key: taskPointerKey(watch.workspaceId),
        UpdateExpression: "REMOVE pendingPrompt", ConditionExpression: "attribute_exists(pk)",
      } },
      { Delete: drop },
    ] }));
    return "failed";
  } catch (error) {
    // A result landed first: it stands, and the next run drops the watch.
    if (error instanceof Error && error.name === "TransactionCanceledException") return "kept";
    throw error;
  }
}
