import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  ActorRefSchema,
  ChannelLinkCodeRecordSchema,
  ChannelLinkSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  LINK_CODE_TTL_SECONDS,
  LinkCodeSchema,
  agentXError,
  channelLinkCodeKey,
  channelLinkKey,
  developerChannelLinkKey,
  generateLinkCode,
  linkCodeHash,
  maskChannelUserId,
  type ActorRef,
  type ChannelLink,
} from "@agentx/contracts";

/**
 * Spec 062 FR-030, FR-031: linking a channel actor to a developer, in the state table. A link is durable and is
 * stored under the actor and under the developer. A link code is short-lived: the table's TTL removes it by
 * `indexExpiresAt`, and every read also checks `expiresAt`, since the TTL lags.
 */
export interface ChannelLinkDependencies {
  documentClient: Pick<DynamoDBDocumentClient, "send">;
  stateTableName: string;
  now: () => number;
}

const nowSeconds = (deps: ChannelLinkDependencies) => Math.floor(deps.now() / 1000);

/** The developer an actor is linked to, or undefined. */
export async function linkedDeveloper(deps: ChannelLinkDependencies, actor: ActorRef): Promise<string | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.stateTableName, Key: channelLinkKey(actor), ConsistentRead: true }));
  const parsed = ChannelLinkSchema.safeParse(stripKeys(response.Item));
  return parsed.success ? parsed.data.developerId : undefined;
}

const STORAGE_FIELDS = new Set(["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE]);

/** A stored row without its key, entity type and TTL attribute, for the strict schemas. */
function stripKeys(item: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return item === undefined ? undefined : Object.fromEntries(Object.entries(item).filter(([field]) => !STORAGE_FIELDS.has(field)));
}

/** Mints a one-time code bound to the actor. Only its hash is stored; the code itself goes into the link URL once. */
export async function issueLinkCode(deps: ChannelLinkDependencies, actor: ActorRef): Promise<{ code: string; expiresAt: number }> {
  const parsedActor = ActorRefSchema.parse(actor);
  channelLinkKey(parsedActor); // refuses a Slack actor
  const code = generateLinkCode();
  const expiresAt = nowSeconds(deps) + LINK_CODE_TTL_SECONDS;
  const record = ChannelLinkCodeRecordSchema.parse({ actor: parsedActor, expiresAt, createdAt: new Date(deps.now()).toISOString() });
  await deps.documentClient.send(new PutCommand({
    TableName: deps.stateTableName,
    Item: { ...channelLinkCodeKey(linkCodeHash(code)), entityType: "CHANNEL_LINK_CODE", ...record, [INDEX_EXPIRY_ATTRIBUTE]: expiresAt },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  return { code, expiresAt };
}

async function readCode(deps: ChannelLinkDependencies, code: string) {
  if (!LinkCodeSchema.safeParse(code).success) return undefined;
  const key = channelLinkCodeKey(linkCodeHash(code));
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.stateTableName, Key: key, ConsistentRead: true }));
  const parsed = ChannelLinkCodeRecordSchema.safeParse(stripKeys(response.Item));
  if (!parsed.success || parsed.data.expiresAt <= nowSeconds(deps)) return undefined;
  return { key, record: parsed.data };
}

/** FR-031: what the confirmation names. Undefined for an unknown, used or expired code. */
export async function previewLinkCode(deps: ChannelLinkDependencies, code: string): Promise<{ channel: string; maskedUserId: string } | undefined> {
  const found = await readCode(deps, code);
  return found === undefined ? undefined : { channel: found.record.actor.channel, maskedUserId: maskChannelUserId(found.record.actor.userId) };
}

/**
 * FR-031: links the code's actor to the signed-in developer, once. The code is deleted in the same transaction, on
 * the condition that it is still unexpired, and the link is written only if the actor is not linked already.
 */
export async function redeemLinkCode(deps: ChannelLinkDependencies, developerId: string, code: string): Promise<ChannelLink> {
  const found = await readCode(deps, code);
  if (found === undefined) throw agentXError("NOT_FOUND", "this link has expired or was already used; send Rovara a new message to get another");
  const link = ChannelLinkSchema.parse({ actor: found.record.actor, developerId, linkedAt: new Date(deps.now()).toISOString() });
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: deps.stateTableName, Key: found.key, ConditionExpression: "attribute_exists(pk) AND expiresAt > :now", ExpressionAttributeValues: { ":now": nowSeconds(deps) } } },
        { Put: { TableName: deps.stateTableName, Item: { ...channelLinkKey(link.actor), entityType: "CHANNEL_LINK", ...link }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: deps.stateTableName, Item: { ...developerChannelLinkKey(developerId, link.actor), entityType: "DEVELOPER_CHANNEL_LINK", ...link } } },
      ],
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      throw agentXError("CHANGE_STALE", "this link was already used, or that account is already linked; remove the old link first");
    }
    throw error;
  }
  return link;
}

/** A developer's own links. */
export async function listDeveloperLinks(deps: ChannelLinkDependencies, developerId: string): Promise<ChannelLink[]> {
  const links: ChannelLink[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.stateTableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `DEVELOPER_CHANNEL_LINKS#${developerId}` },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }));
    for (const item of response.Items ?? []) {
      const parsed = ChannelLinkSchema.safeParse(stripKeys(item));
      if (parsed.success) links.push(parsed.data);
    }
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  return links;
}

/**
 * Removes a link. `developerId` is the developer removing their own link, or undefined for an administrator, who may
 * remove anyone's. A developer can remove only a link to themselves.
 */
export async function removeLink(deps: ChannelLinkDependencies, actor: ActorRef, developerId: string | undefined): Promise<{ removed: true; link: ChannelLink }> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.stateTableName, Key: channelLinkKey(actor), ConsistentRead: true }));
  const parsed = ChannelLinkSchema.safeParse(stripKeys(response.Item));
  if (!parsed.success || (developerId !== undefined && parsed.data.developerId !== developerId)) throw agentXError("NOT_FOUND", "link not found");
  const link = parsed.data;
  await deps.documentClient.send(new TransactWriteCommand({
    TransactItems: [
      { Delete: { TableName: deps.stateTableName, Key: channelLinkKey(link.actor), ConditionExpression: "developerId = :developer", ExpressionAttributeValues: { ":developer": link.developerId } } },
      { Delete: { TableName: deps.stateTableName, Key: developerChannelLinkKey(link.developerId, link.actor) } },
    ],
  }));
  return { removed: true, link };
}
