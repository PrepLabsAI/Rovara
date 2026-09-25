import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  TURN_TEXT_LIMIT,
  TurnRecordSchema,
  redactAndCap,
  turnRecordKeys,
  type SlackRequestMessage,
  type TurnDisposition,
  type TurnObservation,
  type TurnRecord,
} from "@agentx/contracts";

/** DynamoDB's item limit is 400 KB; this leaves room for keys and attribute overhead. */
export const TURN_ITEM_BYTE_BUDGET = 350_000;
/** A record write gives up after this long, so a hung request cannot hold the thread. */
export const TURN_WRITE_TIMEOUT_MS = 5_000;

export interface TurnDraft {
  disposition: TurnDisposition;
  workspaceId?: string;
  conversationId?: string;
  settingsRevision?: number;
  /** The orchestrator's answer or failure text; otherwise the last message posted is used. */
  responseText?: string;
  error?: { name: string; code?: string };
}

export interface TurnRecordSink {
  write(record: TurnRecord): Promise<"written" | "duplicate">;
}

/**
 * Builds and validates one turn record. Free text reaches the record only through redactAndCap;
 * arguments and recording errors arrive already redacted or fixed from the recorder's observation.
 * Throws when the result fails TurnRecordSchema, so the caller reports it.
 */
export function buildTurnRecord(input: {
  message: SlackRequestMessage;
  subject: string;
  startedAt: Date;
  finishedAt: Date;
  draft: TurnDraft;
  observation: TurnObservation;
  lastPosted: string;
}): TurnRecord {
  const { message, draft } = input;
  const request = redactAndCap(message.text, TURN_TEXT_LIMIT);
  const response = redactAndCap(draft.responseText ?? input.lastPosted, TURN_TEXT_LIMIT);
  return TurnRecordSchema.parse({
    ...input.observation,
    eventId: message.eventId,
    subject: input.subject,
    receivedAt: message.receivedAt,
    requestedBy: { teamId: message.thread.teamId, userId: message.userId },
    ...(draft.workspaceId === undefined ? {} : { workspaceId: draft.workspaceId }),
    ...(draft.conversationId === undefined ? {} : { conversationId: draft.conversationId }),
    ...(draft.settingsRevision === undefined ? {} : { settingsRevision: draft.settingsRevision }),
    disposition: draft.disposition,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    requestText: request.text,
    responseText: response.text,
    ...(request.truncated || response.truncated ? { textTruncated: true } : {}),
    ...(draft.error === undefined ? {} : { error: draft.error }),
  });
}

/** Halves the longer text until the record fits, then drops call arguments; says what it trimmed. */
export function fitTurnRecord(record: TurnRecord, budget = TURN_ITEM_BYTE_BUDGET): TurnRecord {
  let fitted = record;
  const size = () => Buffer.byteLength(JSON.stringify(fitted), "utf8");
  while (size() > budget && (fitted.requestText.length > 1_000 || fitted.responseText.length > 1_000)) {
    const key = fitted.responseText.length >= fitted.requestText.length ? "responseText" : "requestText";
    fitted = { ...fitted, [key]: halve(fitted[key]), textTruncated: true };
  }
  if (size() > budget) {
    fitted = { ...fitted, calls: fitted.calls.map((call) => ({ ...call, arguments: "[omitted]" })), callsTruncated: true };
  }
  return fitted;
}

/** Cuts text in half without splitting a surrogate pair. */
function halve(text: string): string {
  let cut = Math.floor(text.length / 2);
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

export class DynamoTurnRecordWriter implements TurnRecordSink {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
    private readonly timeoutMs = TURN_WRITE_TIMEOUT_MS,
  ) {}

  async write(record: TurnRecord): Promise<"written" | "duplicate"> {
    // `project` is added at export from the workspace; it is never stored.
    const stored = Object.fromEntries(Object.entries(fitTurnRecord(record)).filter(([key]) => key !== "project"));
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { ...turnRecordKeys(record), ...stored },
        // The key derives from the Slack event, so a redelivered event finds its first record here.
        ConditionExpression: "attribute_not_exists(pk)",
      }), { abortSignal: AbortSignal.timeout(this.timeoutMs) });
      return "written";
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return "duplicate";
      throw error;
    }
  }
}
