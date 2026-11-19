// The conversation a task was started from. When a person starts work from a chat, what that work later needs from them is told in the same conversation as well as to the places they chose for notices (`core/notify`). The record
// is one row per session under the company scope (decision 58); it holds the conversation and the person who started it, and nothing of the message.
import { ActorRefSchema, ConversationRefSchema, INDEX_EXPIRY_ATTRIBUTE, SESSION_RETENTION_DAYS, orgScoped, when, type DocumentKey, type DocumentStore, type OrgId } from "@agentx/contracts";
import { z } from "zod";

// `actor` is the chat account that started the work. It is what a host's explicit-member rule (`isMember`) is asked about when a message is sent to the thread later; a row without one (an older row) is never sent to by a
// host that has such a rule.
const ThreadRowSchema = z.object({ conversation: ConversationRefSchema, personId: z.string().min(1).max(200), actor: ActorRefSchema.optional() }).strict();
export type TaskThread = z.infer<typeof ThreadRowSchema>;

export const taskThreadKey = (orgId: OrgId, sessionId: string): DocumentKey => ({ pk: orgScoped(orgId, `CHANNEL_THREAD#${sessionId}`), sk: "META" });

/** Remembers where a session was started from. Written once: a second call for the same session changes nothing. */
export async function recordTaskThread(deps: { store: Pick<DocumentStore, "put">; orgId: OrgId; now: () => number }, input: { sessionId: string } & TaskThread): Promise<void> {
  const row = ThreadRowSchema.parse({ conversation: input.conversation, personId: input.personId, ...(input.actor === undefined ? {} : { actor: input.actor }) });
  const { actor, ...rest } = row;
  await deps.store.put({
    item: { ...taskThreadKey(deps.orgId, input.sessionId), entityType: "CHANNEL_THREAD", ...rest, ...(actor === undefined ? {} : { actor }), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1000) + SESSION_RETENTION_DAYS * 86_400 },
    condition: when.absent(),
  });
}

export async function readTaskThread(store: Pick<DocumentStore, "get">, orgId: OrgId, sessionId: string): Promise<TaskThread | undefined> {
  const item = await store.get(taskThreadKey(orgId, sessionId));
  if (item === undefined) return undefined;
  const parsed = ThreadRowSchema.safeParse({ conversation: item["conversation"], personId: item["personId"], ...(item["actor"] === undefined ? {} : { actor: item["actor"] }) });
  return parsed.success ? parsed.data : undefined;
}
