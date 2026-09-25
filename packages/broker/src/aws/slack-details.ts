import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DETAILS_ACTION,
  TURN_DETAILS_ATTRIBUTES,
  TURN_RETENTION_DAYS,
  detailsExpireAt,
  parseDetailsButtonValue,
  slackThreadSubject,
  turnDetailsFromItem,
  turnDetailsKey,
} from "@agentx/contracts";
import { detailsMessageView, turnDetailsView, type SlackModalView } from "./slack-details-view.js";
import type { SlackIngressLog } from "./slack-ingress.js";
import type { SlackActionHandler, SlackBlockAction } from "./slack-interactivity.js";

/** A record read gives up after this long, so the modal still opens inside Slack's 3-second trigger window. */
export const DETAILS_READ_TIMEOUT_MS = 1_000;
/** The Slack service writes the record just after it posts the reply; a click this soon may beat the write. */
export const DETAILS_SAVE_GRACE_MS = 60_000;

export const DETAILS_NOT_FOUND = "AgentX couldn't find the details for this reply.";
export const DETAILS_SAVING = "The details for this reply are still being saved. Close this and press Details again in a moment.";
export const DETAILS_NOT_SAVED = "AgentX has no saved details for this reply. Saving them may have failed; an administrator can look for turn_record.write_failed in the Slack service logs.";
export const DETAILS_UNREADABLE = "The saved details for this reply could not be read. An administrator can export the turn with `agentx admin turns export`.";
export const DETAILS_UNAVAILABLE = "AgentX couldn't load the details right now. Close this and press Details again.";
export const DETAILS_OPEN_FAILED = "I couldn't open the details in time. Press Details again.";

export function detailsExpiredText(receivedAt: string): string {
  const seconds = Math.floor(Date.parse(receivedAt) / 1_000);
  return `AgentX keeps turn details for ${TURN_RETENTION_DAYS} days. The details for this reply, from <!date^${seconds}^{date_short}|${receivedAt.slice(0, 10)}>, are no longer kept.`;
}

export interface DetailsClickDependencies {
  /** One record by key, projected to TURN_DETAILS_ATTRIBUTES; undefined when there is none. */
  readDetails: (key: { pk: string; sk: string }) => Promise<Record<string, unknown> | undefined>;
  openView: (triggerId: string, view: SlackModalView) => Promise<void>;
  respondEphemeral: (responseUrl: string, text: string) => Promise<void>;
  now?: () => number;
  log?: SlackIngressLog;
}

/**
 * The Details button (spec 014 FR-024). It opens a modal, for the member who clicked only, built
 * from the turn record of the reply the button is on. Any member who can see the reply may open it
 * (the plan's ruling R1). The record is looked up in the thread of the clicked message, never a
 * thread the button names, and nothing is posted to the thread. Every outcome the member can meet is
 * said in the modal, or privately through response_url when the modal cannot open. Log lines carry
 * IDs and categories, never record text.
 */
export function detailsActionHandler(dependencies: DetailsClickDependencies): SlackActionHandler {
  const now = dependencies.now ?? Date.now;
  const log: SlackIngressLog = dependencies.log ?? (() => undefined);

  const open = async (action: SlackBlockAction, view: SlackModalView): Promise<void> => {
    try {
      await dependencies.openView(action.triggerId, view);
    } catch (error) {
      log("interaction.details_open_failed", { errorName: errorName(error), slackError: slackError(error) });
      // Guarded like 14c part 2's confirmation handler: a throw here would make the endpoint send its
      // confirmation-worded CLICK_FAILED_TEXT ("reply `@AgentX yes`"), which is wrong for Details.
      try {
        await dependencies.respondEphemeral(action.responseUrl, DETAILS_OPEN_FAILED);
      } catch (respondError) {
        log("interaction.respond_failed", { errorName: errorName(respondError) });
      }
    }
  };

  const refuse = async (action: SlackBlockAction, reason: string, text: string): Promise<void> => {
    log("interaction.details_refused", { reason, viewerId: action.userId });
    await open(action, detailsMessageView(text));
  };

  const show = async (action: SlackBlockAction): Promise<void> => {
    // Slack Connect (the plan's ruling): a member from another workspace is told privately that there
    // are no details, and nothing is read. The team comes from the signed payload's user, never the button.
    if (action.userTeamId !== action.thread.teamId) {
      await refuse(action, "external_member", DETAILS_NOT_FOUND);
      return;
    }
    const reference = parseDetailsButtonValue(action.value);
    if (reference === undefined) {
      await refuse(action, "malformed_value", DETAILS_NOT_FOUND);
      return;
    }
    if (now() >= detailsExpireAt(reference)) {
      await refuse(action, "expired", detailsExpiredText(reference.receivedAt));
      return;
    }
    const subject = slackThreadSubject(action.thread);
    let item: Record<string, unknown> | undefined;
    try {
      item = await dependencies.readDetails(turnDetailsKey(subject, reference));
    } catch (error) {
      log("interaction.details_read_failed", { errorName: errorName(error) });
      await open(action, detailsMessageView(DETAILS_UNAVAILABLE));
      return;
    }
    if (item === undefined) {
      // Measured from the reply itself: a long turn posts its reply minutes after receivedAt.
      const repliedAt = Number(action.messageTs) * 1_000;
      if (now() - repliedAt < DETAILS_SAVE_GRACE_MS) await refuse(action, "not_saved_yet", DETAILS_SAVING);
      else await refuse(action, "not_found", DETAILS_NOT_SAVED);
      return;
    }
    // DynamoDB deletes expired items up to 48 hours late; never show one.
    if (typeof item.expiresAt === "number" && item.expiresAt <= Math.floor(now() / 1_000)) {
      await refuse(action, "expired", detailsExpiredText(reference.receivedAt));
      return;
    }
    const parsed = turnDetailsFromItem(item);
    if (!parsed.ok) {
      log("interaction.details_invalid", { eventId: reference.eventId, fields: parsed.fields.join(",") });
      await open(action, detailsMessageView(DETAILS_UNREADABLE));
      return;
    }
    const details = parsed.details;
    // The key already binds thread and event; a record that disagrees with it is refused, never shown.
    if (details.subject !== subject || details.eventId !== reference.eventId || details.receivedAt !== reference.receivedAt
      || details.requestedBy.teamId !== action.thread.teamId) {
      await refuse(action, "mismatch", DETAILS_NOT_FOUND);
      return;
    }
    log("interaction.details_opened", {
      eventId: details.eventId, viewerId: action.userId, viewer: action.userId === details.requestedBy.userId ? "requester" : "member",
    });
    await open(action, turnDetailsView(details));
  };

  return {
    matches: (actionId) => actionId === DETAILS_ACTION,
    async handle(action) {
      try {
        await show(action);
      } catch (error) {
        // Nothing may escape: the endpoint would answer with its confirmation-worded CLICK_FAILED_TEXT.
        log("interaction.details_failed", { errorName: errorName(error) });
        await open(action, detailsMessageView(DETAILS_UNAVAILABLE));
      }
    },
  };
}

/**
 * Reads one turn record by key for the Details view: consistently, with a short deadline, and only
 * the attributes the view shows. The ingress's IAM grant allows exactly these (dynamodb:Attributes),
 * so asking for more is refused.
 */
export function dynamoTurnDetailsReader(client: Pick<DynamoDBDocumentClient, "send">, tableName: string, timeoutMs = DETAILS_READ_TIMEOUT_MS) {
  const names = Object.fromEntries(TURN_DETAILS_ATTRIBUTES.map((name, index) => [`#a${index}`, name]));
  const projection = Object.keys(names).join(", ");
  return async (key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> => {
    const response = await client.send(new GetCommand({
      TableName: tableName,
      Key: key,
      ConsistentRead: true,
      ProjectionExpression: projection,
      ExpressionAttributeNames: names,
    }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    return response.Item as Record<string, unknown> | undefined;
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 128) : "unknown";
}

/** Slack's error code from slackApi's message ("Slack views.open failed: expired_trigger_id"); codes carry no user text. */
function slackError(error: unknown): string {
  const match = error instanceof Error ? /failed: ([a-z_]{1,64})$/.exec(error.message) : null;
  return match?.[1] ?? "none";
}
