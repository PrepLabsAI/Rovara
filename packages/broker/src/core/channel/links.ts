// Linking a chat person to the person Rovara knows, for the in-process channel adapters (owner decision 58). A message or a click from a chat tool says who is speaking only as the adapter heard it; the core acts for a
// person only when that chat account was linked to them, and the link is made by the person themselves on a surface that proves who they are (on a laptop: the owner's own terminal, `rovara channel link <code>`).
//
// The keys are the company-scoped ones (`ORG#<company>#CHANNEL_LINK#<channel>/<tenant>`, `...#DEVELOPER_CHANNEL_LINKS#<person>`, `...#CHANNEL_LINK_CODE#<hash>`), so a company's links are its own. A code is short-lived and one use:
// only its hash is stored, it is deleted in the transaction that makes the link, and every read also checks its expiry (the store deletes late).
import {
  ActorRefSchema, ChannelLinkCodeRecordSchema, ChannelLinkSchema, INDEX_EXPIRY_ATTRIBUTE, LINK_CODE_TTL_SECONDS, LinkCodeSchema, agentXError, generateLinkCode, linkCodeHash, maskChannelUserId, orgChannelLinkCodeKey,
  orgChannelLinkKey, orgDeveloperChannelLinkKey, orgScoped, queryAll, when,
  type ActorRef, type ChannelLink, type DocumentStore, type OrgId, type StoredDocument,
} from "@agentx/contracts";

export interface ChannelLinkDeps {
  store: DocumentStore;
  orgId: OrgId;
  now: () => number;
}

const STORAGE_FIELDS = new Set(["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE]);
const nowSeconds = (deps: ChannelLinkDeps): number => Math.floor(deps.now() / 1000);

/** A stored row without its key, entity type and expiry attribute, for the strict schemas. */
const bare = (item: StoredDocument | undefined): Record<string, unknown> | undefined => (item === undefined ? undefined : Object.fromEntries(Object.entries(item).filter(([field]) => !STORAGE_FIELDS.has(field))));

/** The person a chat account is linked to, or undefined. */
export async function linkedPerson(deps: ChannelLinkDeps, actor: ActorRef): Promise<string | undefined> {
  const parsed = ChannelLinkSchema.safeParse(bare(await deps.store.get(orgChannelLinkKey(deps.orgId, actor))));
  return parsed.success ? parsed.data.developerId : undefined;
}

/** A one-time code bound to the chat account. Only its hash is stored; the code itself is shown once, to the person on that account. */
export async function issueChannelLinkCode(deps: ChannelLinkDeps, actor: ActorRef): Promise<{ code: string; expiresAt: number }> {
  const parsedActor = ActorRefSchema.parse(actor);
  const code = generateLinkCode();
  const expiresAt = nowSeconds(deps) + LINK_CODE_TTL_SECONDS;
  const record = ChannelLinkCodeRecordSchema.parse({ actor: parsedActor, expiresAt, createdAt: new Date(deps.now()).toISOString() });
  const written = await deps.store.put({ item: { ...orgChannelLinkCodeKey(deps.orgId, linkCodeHash(code)), entityType: "CHANNEL_LINK_CODE", ...record, [INDEX_EXPIRY_ATTRIBUTE]: expiresAt }, condition: when.absent() });
  if (!written.applied) throw agentXError("RUNTIME_UNAVAILABLE", "a link code could not be made; try again");
  return { code, expiresAt };
}

async function readCode(deps: ChannelLinkDeps, code: string) {
  if (!LinkCodeSchema.safeParse(code).success) return undefined;
  const key = orgChannelLinkCodeKey(deps.orgId, linkCodeHash(code));
  const parsed = ChannelLinkCodeRecordSchema.safeParse(bare(await deps.store.get(key)));
  if (!parsed.success || parsed.data.expiresAt <= nowSeconds(deps)) return undefined;
  return { key, record: parsed.data };
}

/** What a confirmation names (the channel and the account, masked). Undefined for an unknown, used or expired code. */
export async function previewChannelLinkCode(deps: ChannelLinkDeps, code: string): Promise<{ channel: string; tenant: string; userId: string; maskedUserId: string } | undefined> {
  const found = await readCode(deps, code);
  const actor = found?.record.actor;
  // The page is the owner's own: the whole account (its workspace and its id) is shown, because a masked id is nothing to check a stranger's code against.
  return actor === undefined ? undefined : { channel: actor.channel, tenant: actor.tenant, userId: actor.userId, maskedUserId: maskChannelUserId(actor.userId) };
}

/**
 * Links the code's chat account to `personId`, once. The code is deleted in the same transaction, on the condition that it is still unexpired, and the link is written only if the account is not linked already.
 * The caller proves who `personId` is (the owner's session); nothing here believes a name a chat message gave.
 */
export async function redeemChannelLinkCode(deps: ChannelLinkDeps, personId: string, code: string): Promise<ChannelLink> {
  const found = await readCode(deps, code);
  if (found === undefined) throw agentXError("NOT_FOUND", "this code has expired or was already used; send Rovara a new message in the chat to get another");
  const link = ChannelLinkSchema.parse({ actor: found.record.actor, developerId: personId, linkedAt: new Date(deps.now()).toISOString() });
  const outcome = await deps.store.transact([
    { kind: "delete", key: found.key, condition: when.and(when.present(), when.gt("expiresAt", nowSeconds(deps))) },
    { kind: "put", item: { ...orgChannelLinkKey(deps.orgId, link.actor), entityType: "CHANNEL_LINK", ...link }, condition: when.absent() },
    { kind: "put", item: { ...orgDeveloperChannelLinkKey(deps.orgId, personId, link.actor), entityType: "DEVELOPER_CHANNEL_LINK", ...link } },
  ]);
  if (!outcome.applied) throw agentXError("CHANGE_STALE", "this code was already used, or that account is already linked; remove the old link first");
  return link;
}

/** The company-scoped partition a person's links are listed from (exported for the erase walk and tests). */
export const channelLinksPartition = (orgId: OrgId, personId: string): string => orgScoped(orgId, `DEVELOPER_CHANNEL_LINKS#${personId}`);

/** A person's own links. */
export async function listChannelLinks(deps: ChannelLinkDeps, personId: string): Promise<ChannelLink[]> {
  const rows = await queryAll(deps.store, { pk: channelLinksPartition(deps.orgId, personId) });
  return rows.flatMap((row) => {
    const parsed = ChannelLinkSchema.safeParse(bare(row));
    return parsed.success ? [parsed.data] : [];
  });
}

/** Removes a link. A person removes only a link to themselves; the answer is NOT_FOUND for anyone else's, so it does not say whether it exists. */
export async function removeChannelLink(deps: ChannelLinkDeps, actor: ActorRef, personId: string): Promise<ChannelLink> {
  const parsed = ChannelLinkSchema.safeParse(bare(await deps.store.get(orgChannelLinkKey(deps.orgId, actor))));
  if (!parsed.success || parsed.data.developerId !== personId) throw agentXError("NOT_FOUND", "link not found");
  const link = parsed.data;
  const outcome = await deps.store.transact([
    { kind: "delete", key: orgChannelLinkKey(deps.orgId, link.actor), condition: when.eq("developerId", link.developerId) },
    { kind: "delete", key: orgDeveloperChannelLinkKey(deps.orgId, link.developerId, link.actor) },
  ]);
  if (!outcome.applied) throw agentXError("NOT_FOUND", "link not found");
  return link;
}
