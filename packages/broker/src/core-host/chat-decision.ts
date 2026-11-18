// HW5b (owner decision 2026-11-18): the hosted Slack plan card matches the laptop's. A press of Approve, or the words typed for Request changes, on a card a hosted company's chat thread was given (`core/channel/thread-notices.ts`)
// is a REQUEST to the same approval gate the web uses, never an approval: the laptop's rule of 2026-11-12 (`ports/policy-defaults.ts` `chat`, `local/app/chat.ts` `work().decide`, `core/channel/sink.ts` `decision`) on a deployed install.
//
// The checks, in order (every refusal writes nothing and is an answer, not a throw; a throw means the decision was not taken and the chat may try again):
//   1. the press is well formed (`ChannelDecisionSchema`), is an Approve or a Request changes (never a rejection or a skip), and the account and the conversation are one workspace (a guest of a shared channel is refused);
//   2. the workspace belongs to the caller's company (`ChatThreads.companyOf`) and the account is linked to the caller NOW (`ChatThreads.personOf`; the caller is the person the broker resolved from the same account);
//   3. the press acts once (a claim row per company and event id; a retry of the same press is a `duplicate`);
//   4. the card is one Rovara posted for THIS company, in this conversation, still open, for this exact revision and content digest (`cards.ts`); a stale card is refused;
//   5. a plan card of low or medium risk, that offered this answer (`cardMayBeDecidedInChat`: high risk is never decided here), and a request for changes carries the person's words;
//   6. only then the gate: `decide` with a credential of the chat's own method (`chat-<channel>`), whose `verify` is the hosted approvers' (`hosted-approvers.ts`: live member, the task's own person, the project's grant, the workspace the
//      company's, low or medium risk, never a rejection). A link the press relied on is the decision's own transaction fence (an unlink that commits first wins). The gate stages the audit event in the SAME transaction as the write.
//
// Nothing here believes the chat's word for who it is: the gate's Approvers read the link, the membership and the task's owner again.
import { createHash } from "node:crypto";
import {
  ChannelDecisionSchema, INDEX_EXPIRY_ATTRIBUTE, orgScoped, when,
  type ActorRef, type ConversationRef, type DocumentKey, type DocumentStore, type OrgId, type TransactItem,
} from "@agentx/contracts";
import { cardMayBeDecidedInChat, readApprovalCard, type ApprovalCard } from "../core/channel/cards.js";
import { tenantIsCompanys } from "../core/channel/company.js";
import { channelLinkFence } from "../core/channel/links.js";
import { cleanChangeReason, decisionRefusalWords } from "../core/channel/sink.js";
import type { DecisionGate, DecisionOutcome } from "../core/decisions/approval-gate.js";
import { chatApprovalMethod } from "./hosted-approvers.js";
import type { ChatThreads } from "./chat-threads.js";
import type { DeployedCaller } from "./dev-routes.js";

/** What the chat heard: one press (Approve), or the words typed in the box Request changes opened. `eventId` is the chat's own id for it (the same for every copy and retry of it). */
export interface ChatDecisionPress {
  conversation: ConversationRef;
  actor: ActorRef;
  eventId: string;
  requestId: string;
  expectedRevision: number;
  artifactDigest: string;
  decision: "APPROVE" | "REQUEST_CHANGES";
  /** A request for changes: what the person typed. An approval: ignored (the decision records fixed words). */
  reason: string;
}

/** What became of it. A `refused` reason is one of the gate's or this module's; the words said back are fixed (`chatDecisionWords`). */
export type ChatDecisionResult =
  | { outcome: "decided" }
  | { outcome: "duplicate" }
  | { outcome: "refused"; reason: string };

export interface ChatDecisionCompany {
  store: DocumentStore;
  gate: Pick<DecisionGate, "decide">;
}

export interface ChatDecisionDeps {
  chatThreads: Pick<ChatThreads, "companyOf" | "adapterFor" | "personOf">;
  /** The company's own store and approval gate; undefined (or a throw) when the company is not served. */
  companyFor(companyId: OrgId): Promise<ChatDecisionCompany | undefined>;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** How long an event id is remembered, so a resend runs once. */
const EVENT_DEDUPE_SECONDS = 24 * 3_600;

const refused = (reason: string): ChatDecisionResult => ({ outcome: "refused", reason });

const sameConversation = (a: ConversationRef, b: ConversationRef): boolean => a.channel === b.channel && a.tenant === b.tenant && a.space === b.space && a.thread === b.thread;

/**
 * The token a chat press carries. It is made from the card and the account that pressed, NOT from the press itself, so the same person pressing the same card again presents the same proof: the gate answers a repeat of a decision it
 * already made as the repeat it is, and a press by another account is another proof. The token proves nothing by itself: the approvers decide from the claimed account.
 */
export const chatPressToken = (card: Pick<ApprovalCard, "requestId">, actor: Pick<ActorRef, "tenant" | "userId">): string =>
  createHash("sha256").update(`chat-press\0${card.requestId}\0${actor.tenant}\0${actor.userId}`).digest("hex");

/** The fixed words for a refusal (the sink's own table; nothing of the person, the task or what was sent). */
export const chatDecisionWords = decisionRefusalWords;

export async function decideFromChat(deps: ChatDecisionDeps, deployed: DeployedCaller, press: ChatDecisionPress): Promise<ChatDecisionResult> {
  const log = (entry: Record<string, unknown>): void => { try { deps.log?.({ component: "chat_decision", ...entry }); } catch { /* a log never changes an answer */ } };
  const parsed = ChannelDecisionSchema.safeParse({
    version: 1, channel: press.actor.channel, eventId: press.eventId, conversation: press.conversation, actor: press.actor, requestId: press.requestId, expectedRevision: press.expectedRevision,
    artifactDigest: press.artifactDigest, decision: press.decision,
    // The schema's own `reason` is a placeholder here: what a request for changes records is the person's words, made safe below (`cleanChangeReason`), and an empty one is refused there.
    reason: "Pressed in chat.", receivedAt: new Date(deps.now()).toISOString(),
  });
  // Only an approval or a request for changes: a rejection is the task page's (the approvers refuse it as well), and a skip is no decision.
  if (!parsed.success || (parsed.data.decision !== "APPROVE" && parsed.data.decision !== "REQUEST_CHANGES")) { log({ event: "refused", reason: "invalid_press" }); return refused("invalid"); }
  const decision = parsed.data;
  const { conversation, actor } = decision;
  const companyId = deployed.principal.companyId;
  // One workspace for the conversation and the account (a guest from a shared channel is another workspace's account), and it is this company's.
  if (actor.tenant !== conversation.tenant || !(await tenantIsCompanys(deps.chatThreads.companyOf, companyId, conversation.channel, conversation.tenant))) { log({ event: "refused", reason: "other_company" }); return refused("not_allowed"); }
  const adapter = deps.chatThreads.adapterFor(companyId, conversation.channel);
  if (adapter === undefined || deps.chatThreads.personOf === undefined) { log({ event: "refused", reason: "chat_not_served" }); return refused("method_not_allowed"); }
  // The account is the caller's own, now: the person the chat's link (or sign-in) names must be the very person the broker resolved.
  let found: Awaited<ReturnType<NonNullable<ChatThreads["personOf"]>>>;
  try { found = await deps.chatThreads.personOf(companyId, actor); } catch { found = undefined; }
  if (found === undefined || found.personId !== deployed.principal.personId) { log({ event: "refused", reason: "not_linked" }); return refused("link_gone"); }
  let company: ChatDecisionCompany | undefined;
  try { company = await deps.companyFor(companyId); } catch { company = undefined; }
  if (company === undefined) { log({ event: "refused", reason: "company_not_served" }); return refused("not_open"); }
  const { store, gate } = company;

  // The card: this company's own, in this conversation, still open.
  const card = await readApprovalCard({ store, orgId: companyId, now: deps.now }, decision.requestId);
  if (card === undefined || card.channel !== conversation.channel || !sameConversation(card.conversation, conversation)) { log({ event: "refused", reason: "not_open" }); return refused("not_open"); }
  if (card.revision !== decision.expectedRevision || card.artifactDigest !== decision.artifactDigest) { log({ event: "refused", reason: "stale" }); return refused("stale"); }
  // A card that is not a plan of low or medium risk, or did not offer this answer, is decided on the task page.
  if (card.kind !== "plan_approval" || card.risk === undefined || !cardMayBeDecidedInChat(adapter, card) || !card.offered.includes(decision.decision)) { log({ event: "refused", reason: "step_up" }); return refused("step_up"); }
  // A request for changes carries what the person wants changed, in their own words: made safe, and never empty.
  const reason = decision.decision === "REQUEST_CHANGES" ? cleanChangeReason(press.reason) : "Pressed in chat.";
  if (reason === "") { log({ event: "refused", reason: "empty_reason" }); return refused("empty_reason"); }

  // The press acts once: one claim per company and event id (a retry of this press, or its second copy, finds it taken). A fault or a refusal below gives the claim back, so a refused press leaves nothing behind and the chat's retry is not taken for a repeat.
  const claim = eventClaimKey(companyId, conversation.channel, decision.eventId);
  const nowSeconds = Math.floor(deps.now() / 1000);
  const taken = await store.put({
    item: { ...claim, entityType: "CHANNEL_CLAIM", expiresAt: nowSeconds + EVENT_DEDUPE_SECONDS, [INDEX_EXPIRY_ATTRIBUTE]: nowSeconds + EVENT_DEDUPE_SECONDS },
    condition: when.or(when.absent(), when.lte("expiresAt", nowSeconds)),
  });
  if (!taken.applied) { log({ event: "duplicate" }); return { outcome: "duplicate" }; }
  try {
    const outcome: DecisionOutcome = decision.decision === "APPROVE" ? "approve" : "request_changes";
    // A link the press relied on is fenced in the decision's own transaction: an unlink that commits after the read above wins. A person known only by the chat's sign-in has no link row to fence.
    const fence: readonly TransactItem[] = found.via === "link" ? [channelLinkFence(companyId, actor, found.personId)] : [];
    const result = await gate.decide({
      companyId, kind: card.subject.type, subjectId: card.subject.id, requestId: card.requestId, outcome, seen: { revision: card.revision, artifactDigest: card.artifactDigest },
      credentials: [{ method: chatApprovalMethod(conversation.channel), token: chatPressToken(card, actor), claimedAccount: { provider: conversation.channel, tenant: actor.tenant, accountId: actor.userId } }],
      reason, fence,
    });
    if (result.status === "refused") {
      // A refusal writes nothing: the claim is given back too, so a refused press leaves no row (and a press that is allowed after the cause is gone is not taken for a repeat).
      await store.delete({ key: claim }).catch(() => undefined);
      log({ event: "refused", reason: result.reason });
      return refused(result.reason);
    }
    // A repeat of a decision already made (another click on the card) changes nothing, and its claim is given back too: only the press that decided keeps its claim (the chat's own retry of it is a `duplicate`).
    if (result.status === "replayed") await store.delete({ key: claim }).catch(() => undefined);
    log({ event: result.status === "replayed" ? "replayed" : "decided", outcome });
    return { outcome: "decided" };
  } catch (error) {
    await store.delete({ key: claim }).catch(() => undefined);
    log({ event: "failed", errorName: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}

function eventClaimKey(companyId: OrgId, channel: string, eventId: string): DocumentKey {
  return { pk: orgScoped(companyId, `CHANNEL_CLAIM#${channel}/EVENT#decision/${eventId}`), sk: "CLAIM" };
}
