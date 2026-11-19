// An approval card: the message that asks a person, in a chat, to look at something waiting for them (`approval_request`, spec 062). Rovara writes the card's record FIRST and sends the message second, so an answer can never
// arrive for a card the core did not make. The record names what the card was about (the kind, the subject, the exact revision and content digest the person was shown) and where it was posted; a decision that comes back is
// matched against it (`sink.ts`) before anything is asked of the approval gate.
//
// The plan's card (`thread-notices.ts`) is the one caller: when a plan waits for review it is posted to the thread the task was started from. A host with an https task address links it; a host without one (a laptop) says where to open the task.
//
// A card does not approve. A chat click is a request that the gate may refuse: the decision's authority comes from the Approvers seam, which names the methods it takes. The kinds that ask for a sign-in (`admin`, and a plan of high risk) are
// sent with no buttons at all (`shapeApprovalRequest`): the card is a pointer to the task page. A plan of low or medium risk has Approve and Request changes (owner decision of 2026-11-12), decided through the same gate as the web app.
import { randomUUID } from "node:crypto";
import {
  ConversationRefSchema, INDEX_EXPIRY_ATTRIBUTE, adapterMayDecide, agentXError, channelEventId, orgScoped, shapeApprovalRequest,
  type ChannelAdapter, type ChannelDecision, type ChannelEvent, type ConversationRef, type DocumentKey, type DocumentStore, type OrgId, type StepUpKind,
} from "@agentx/contracts";
import { z } from "zod";
import { tenantIsCompanys, type ChannelCompanyOf } from "./company.js";

/** How long a card stays answerable. */
export const CARD_TTL_SECONDS = 24 * 3_600;

const CardSchema = z.object({
  requestId: z.string().uuid(),
  channel: z.string(),
  kind: z.enum(["plan_approval", "admin", "other"]),
  subject: z.object({ type: z.string().min(1).max(60), id: z.string().min(1).max(200) }).strict(),
  revision: z.number().int().positive(),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** The risk the card showed, for a plan: low and medium are decided in the chat, high on the task page. Absent on a card that names none (such a card keeps the adapter's own step-up rule). */
  risk: z.enum(["low", "medium", "high"]).optional(),
  conversation: ConversationRefSchema,
  /** The decisions the card offered (none for a stepped-up kind). */
  offered: z.array(z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "SKIP"])).max(4),
  sentAt: z.string().datetime(),
  expiresAt: z.number().int().positive(),
}).strict();
export type ApprovalCard = z.infer<typeof CardSchema>;
type DecisionValue = ChannelDecision["decision"];

/**
 * Whether a decision on this card may be taken from the chat at all. A plan card that names its risk is decided by it (owner decision of 2026-11-12): low and medium in the chat, high never (the task page, where approval needs a fresh
 * sign-in). Every other card keeps the adapter's own step-up list (the kinds that ask for a sign-in are never decided here). A failure to read the risk is not low: a plan card whose risk is anything but low or medium falls to the list.
 */
export function cardMayBeDecidedInChat(adapter: Pick<ChannelAdapter, "stepUp">, card: Pick<ApprovalCard, "kind" | "risk">): boolean {
  if (card.kind === "plan_approval" && card.risk !== undefined) return card.risk === "low" || card.risk === "medium";
  return adapterMayDecide({ stepUp: [...adapter.stepUp] }, card.kind);
}

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
  /** The risk of a plan (`plan_approval`). A card that names one is decided by it: `high` is never decided in the chat and is sent with no buttons, whatever the adapter's own step-up list says. */
  risk?: "low" | "medium" | "high" | undefined;
  /** What the card says: fixed words and a title, never task content beyond that. */
  text: string;
  /** Send no buttons, whatever the risk: the person decides on the task page. For a plan whose approvers do not take a decision made in this chat. */
  signInOnly?: boolean | undefined;
  /** Where the person decides, on a page that signs them in (an https address). Absent: the host has none, and the words say so. */
  taskUrl?: string | undefined;
  /** What a button may answer; a stepped-up kind sends none. */
  actions?: ReadonlyArray<{ decision: DecisionValue; label: string }>;
}

/** Writes the card's record, then sends the message. When the send fails the record is removed and the failure is thrown, so no answer can arrive for a card nobody saw. */
export async function postApprovalCard(deps: { store: DocumentStore; orgId: OrgId; now: () => number; companyOf?: ChannelCompanyOf | undefined }, input: PostApprovalCardInput): Promise<{ requestId: string; eventId: string; expiresAt: number }> {
  if (input.conversation.channel !== input.channel) throw agentXError("CONFIG_INVALID", "the conversation is on another channel");
  // Owner decision 131: a card goes only to a conversation in the company's own chat; nothing is written for another company's.
  if (!(await tenantIsCompanys(deps.companyOf, deps.orgId, input.channel, input.conversation.tenant))) throw agentXError("FORBIDDEN", "that is not a conversation of this company's chat");
  const requestId = randomUUID();
  const eventId = channelEventId();
  const nowMs = deps.now();
  // A plan of high risk is always stepped up, whatever the adapter lists; a card with no risk keeps the adapter's list. The card made here never offers a button the sink would refuse.
  const byRisk = input.kind === "plan_approval" && input.risk !== undefined;
  const stepUp: StepUpKind[] = byRisk ? [...input.adapter.stepUp.filter((kind) => kind !== "plan_approval"), ...(input.risk === "high" || input.signInOnly === true ? ["plan_approval" as const] : [])] : [...input.adapter.stepUp];
  const shaped = shapeApprovalRequest(
    { capabilities: input.adapter.capabilities, stepUp }, { text: input.text, kind: input.kind, requestId, expectedRevision: input.revision, artifactDigest: input.artifactDigest, ...(input.taskUrl === undefined ? {} : { taskUrl: input.taskUrl }) }, input.actions ?? [],
  );
  const card: ApprovalCard = CardSchema.parse({
    requestId, channel: input.channel, kind: input.kind, subject: input.subject, revision: input.revision, artifactDigest: input.artifactDigest, conversation: input.conversation,
    ...(byRisk ? { risk: input.risk } : {}),
    offered: (shaped.actions ?? []).map((action) => action.decision), sentAt: new Date(nowMs).toISOString(), expiresAt: Math.floor(nowMs / 1000) + CARD_TTL_SECONDS,
  });
  const { risk: cardRisk, ...cardRest } = card;
  const written = await deps.store.put({ item: { ...cardKey(deps.orgId, requestId), entityType: "CHANNEL_CARD", ...cardRest, ...(cardRisk === undefined ? {} : { risk: cardRisk }), [INDEX_EXPIRY_ATTRIBUTE]: card.expiresAt }, condition: { op: "notExists", path: ["pk"] } });
  if (!written.applied) throw agentXError("RUNTIME_UNAVAILABLE", "a card could not be made; try again");
  const event = { version: 1 as const, id: eventId, channel: input.channel, conversation: input.conversation, createdAt: new Date(nowMs).toISOString(), type: "approval_request", data: shaped } as ChannelEvent;
  try {
    await input.adapter.deliver(event);
  } catch (error) {
    await deps.store.delete({ key: cardKey(deps.orgId, requestId) }).catch(() => undefined);
    throw error;
  }
  return { requestId, eventId, expiresAt: card.expiresAt };
}
