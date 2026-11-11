// An approval card: the message that asks a person, in a chat, to look at something waiting for them (`approval_request`, spec 062). Rovara writes the card's record FIRST and sends the message second, so an answer can never
// arrive for a card the core did not make. The record names what the card was about (the kind, the subject, the exact revision and content digest the person was shown) and where it was posted; a decision that comes back is
// matched against it (`sink.ts`) before anything is asked of the approval gate.
//
// The seam is for a host that has an https task address: Code's local pages are http and carry the owner's session, so `rovara up` posts no card and nothing calls this there.
//
// A card does not approve. A chat click is a request that the gate may refuse: the decision's authority comes from the Approvers seam, which names the methods it takes, and Code's own does not take a chat one. The kinds that
// ask for a sign-in (`plan_approval`, `admin`) are sent with no buttons at all (`shapeApprovalRequest`): the card is a pointer to the task page.
import { randomUUID } from "node:crypto";
import {
  ConversationRefSchema, INDEX_EXPIRY_ATTRIBUTE, agentXError, channelEventId, orgScoped, shapeApprovalRequest,
  type ChannelAdapter, type ChannelDecision, type ChannelEvent, type ConversationRef, type DocumentKey, type DocumentStore, type OrgId,
} from "@agentx/contracts";
import { z } from "zod";

/** How long a card stays answerable. */
export const CARD_TTL_SECONDS = 24 * 3_600;

const CardSchema = z.object({
  requestId: z.string().uuid(),
  channel: z.string(),
  kind: z.enum(["plan_approval", "admin", "other"]),
  subject: z.object({ type: z.string().min(1).max(60), id: z.string().min(1).max(200) }).strict(),
  revision: z.number().int().positive(),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  conversation: ConversationRefSchema,
  /** The decisions the card offered (none for a stepped-up kind). */
  offered: z.array(z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "SKIP"])).max(4),
  sentAt: z.string().datetime(),
  expiresAt: z.number().int().positive(),
}).strict();
export type ApprovalCard = z.infer<typeof CardSchema>;
type DecisionValue = ChannelDecision["decision"];

export const cardKey = (orgId: OrgId, requestId: string): DocumentKey => ({ pk: orgScoped(orgId, `CHANNEL_CARD#${requestId}`), sk: "CARD" });

export async function readApprovalCard(deps: { store: Pick<DocumentStore, "get">; orgId: OrgId; now: () => number }, requestId: string): Promise<ApprovalCard | undefined> {
  if (!z.string().uuid().safeParse(requestId).success) return undefined;
  const item = await deps.store.get(cardKey(deps.orgId, requestId));
  if (item === undefined) return undefined;
  const parsed = CardSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([field]) => !["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE].includes(field))));
  // The store deletes expired rows late, so every read checks the time itself.
  return parsed.success && parsed.data.expiresAt * 1000 > deps.now() ? parsed.data : undefined;
}

export interface PostApprovalCardInput {
  /** The adapter's name in the registry (`ChannelEvent.channel`). */
  channel: string;
  adapter: Pick<ChannelAdapter, "capabilities" | "stepUp" | "deliver">;
  conversation: ConversationRef;
  kind: "plan_approval" | "admin" | "other";
  subject: { type: string; id: string };
  revision: number;
  artifactDigest: string;
  /** What the card says: fixed words and a title, never task content beyond that. */
  text: string;
  /** Where the person decides, on a page that signs them in (an https address). */
  taskUrl: string;
  /** What a button may answer; a stepped-up kind sends none. */
  actions?: ReadonlyArray<{ decision: DecisionValue; label: string }>;
}

/** Writes the card's record, then sends the message. When the send fails the record is removed and the failure is thrown, so no answer can arrive for a card nobody saw. */
export async function postApprovalCard(deps: { store: DocumentStore; orgId: OrgId; now: () => number }, input: PostApprovalCardInput): Promise<{ requestId: string; eventId: string }> {
  if (input.conversation.channel !== input.channel) throw agentXError("CONFIG_INVALID", "the conversation is on another channel");
  const requestId = randomUUID();
  const eventId = channelEventId();
  const nowMs = deps.now();
  const shaped = shapeApprovalRequest(
    { capabilities: input.adapter.capabilities, stepUp: [...input.adapter.stepUp] }, { text: input.text, kind: input.kind, requestId, expectedRevision: input.revision, artifactDigest: input.artifactDigest, taskUrl: input.taskUrl }, input.actions ?? [],
  );
  const card: ApprovalCard = CardSchema.parse({
    requestId, channel: input.channel, kind: input.kind, subject: input.subject, revision: input.revision, artifactDigest: input.artifactDigest, conversation: input.conversation,
    offered: (shaped.actions ?? []).map((action) => action.decision), sentAt: new Date(nowMs).toISOString(), expiresAt: Math.floor(nowMs / 1000) + CARD_TTL_SECONDS,
  });
  const written = await deps.store.put({ item: { ...cardKey(deps.orgId, requestId), entityType: "CHANNEL_CARD", ...card, [INDEX_EXPIRY_ATTRIBUTE]: card.expiresAt }, condition: { op: "notExists", path: ["pk"] } });
  if (!written.applied) throw agentXError("RUNTIME_UNAVAILABLE", "a card could not be made; try again");
  const event = { version: 1 as const, id: eventId, channel: input.channel, conversation: input.conversation, createdAt: new Date(nowMs).toISOString(), type: "approval_request", data: shaped } as ChannelEvent;
  try {
    await input.adapter.deliver(event);
  } catch (error) {
    await deps.store.delete({ key: cardKey(deps.orgId, requestId) }).catch(() => undefined);
    throw error;
  }
  return { requestId, eventId };
}
