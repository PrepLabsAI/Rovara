// D1 (old workflow engine removed; arch ruling (a), 2026-11-24): the Slack buttons of the old workflow engine's cards (Approve, Request changes, Retry checks, Retry reviews, Retry publish, Keep
// pull requests, Send back, Resolve findings, Close, the PR feedback decision, Retry review) have nothing behind them any more. A press on one of those cards, however old, gets ONE fixed
// answer with a STABLE code, in words from this module only, told privately to the person who pressed (the notifier posts the note as an ephemeral message). Nothing else is read or written
// about the task. D2 deletes the Slack side of these buttons; this module goes with it.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, SlackRequesterSchema, SlackThreadSchema, indexExpiresAt } from "@agentx/contracts";

/** The stable code of the answer. A client may match it; the words may change. */
export const SLACK_RETIRED_BUTTON_CODE = "SLACK_BUTTON_RETIRED";
/** The words the presser hears. The same sentence the Slack side says for a stale card. */
export const SLACK_RETIRED_BUTTON_WORDS = "That button is out of date. Use the latest message in this thread.";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The answer body: a refusal, not an error (Slack must never show a failed save for it). */
export interface RetiredSlackButtonAnswer { refused: true; code: typeof SLACK_RETIRED_BUTTON_CODE; message: typeof SLACK_RETIRED_BUTTON_WORDS }
export const RETIRED_SLACK_BUTTON_ANSWER: RetiredSlackButtonAnswer = Object.freeze({ refused: true, code: SLACK_RETIRED_BUTTON_CODE, message: SLACK_RETIRED_BUTTON_WORDS });

/**
 * The presser's private note in the thread they pressed in, for the notifier to deliver (chat.postEphemeral): one item per invoke (`attemptId`, Lambda's request id, which a retried
 * delivery of the same invoke keeps). Best effort: a note that cannot be written is logged and the answer stands. Nothing is written for a press whose ids are not well formed.
 */
export async function recordRetiredSlackButtonNote(
  dependencies: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string },
  event: { taskId: string; userId: string; thread: unknown; requestId: string },
  attemptId: string,
  now: () => Date = () => new Date(),
  message: string = SLACK_RETIRED_BUTTON_WORDS,
  /** A note is written only for a task that has a record (the old handler read the task first); a press of a card whose task never existed writes nothing. A core task's refusal passes false (its mark is the proof it exists). */
  requireRecord = true,
): Promise<boolean> {
  const thread = SlackThreadSchema.safeParse(event.thread);
  const user = SlackRequesterSchema.shape.userId.safeParse(event.userId);
  if (!ID.test(event.taskId) || !ID.test(event.requestId) || !thread.success || !user.success) return false;
  const at = now().toISOString();
  try {
    if (requireRecord) {
      const record = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: { pk: `DEVTASK#${event.taskId}`, sk: "META" } })) as { Item?: unknown };
      if (record.Item === undefined) return false;
    }
    await dependencies.documentClient.send(new PutCommand({
      TableName: dependencies.tableName,
      Item: { pk: `DEVTASK#${event.taskId}`, sk: `REFUSAL#${event.requestId}#${attemptId}`, entityType: "WORKFLOW_ACTION_REFUSAL", taskId: event.taskId,
        slackUserId: user.data, channelId: thread.data.channelId, threadTs: thread.data.threadTs, message, at, [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(at) },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return true;
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "slack.retired_button_note_unrecorded", taskId: event.taskId, requestId: event.requestId, errorName: error instanceof Error ? error.name : "unknown" }));
    return false;
  }
}
