// What an in-process channel adapter may hand the core (`ChannelInboundSink`, owner decision 58). The adapter is trusted by the config that named it to say what it heard, and NOT for who is speaking or what they may do: this sink
// applies the same checks the channel API applies to a signed webhook adapter (spec 062 FR-021, FR-024, FR-030), so an adapter that runs in the process gets no shortcut.
//
//   message   the chat account and the conversation are of one tenant (an account of another workspace, such as a guest from a shared channel, gets nothing, not even a code); the space is bound to one of the adapter's projects; the
//             account is linked to a person (an unlinked one is told PRIVATELY, once an hour, how to link, and nothing runs); the adapter's own event id is used once; only then is the message given to the work seam, and acknowledged.
//   decision  the same first four checks, then: the request is a card Rovara posted (`cards.ts`), in this conversation, still open, for this exact revision and content digest; the kind may be decided through this adapter (the kinds
//             that ask for a sign-in never are: the answer points to the task page); only then is the decision given to the `decide` seam, which asks the approval gate. A click is a request, never an approval.
//
// The company and the person are the seams a many-company host changes: `companyOf` says which company a conversation's tenant belongs to (Code: the one company) and `personOf` says which person a chat account is (Code: the
// links the owner made on the chat page; a host with its own sign-in answers from its identity data). Every key the sink reads or writes is under the company that answered.
//
// A refusal runs nothing and says nothing but a fixed sentence (never the text of what was sent). The sink never throws for a refusal; it throws only when the store or the work seam failed, and then a claim made for this event is
// released so the adapter's retry is not taken as a repeat.
import {
  ChannelDecisionSchema, InboundMessageSchema, INDEX_EXPIRY_ATTRIBUTE, LINK_REQUIRED_INTERVAL_SECONDS, adapterMayDecide, channelEventId, orgScoped, when,
  type ActorRef, type ChannelAdapter, type ChannelDecision, type ChannelEvent, type ChannelInboundSink, type ConversationRef, type DocumentKey, type DocumentStore, type InboundMessage, type OrgId,
} from "@agentx/contracts";
import { readChannelBinding } from "./bindings.js";
import { readApprovalCard, type ApprovalCard } from "./cards.js";
import { issueChannelLinkCode, linkedPerson } from "./links.js";

type Log = (entry: Record<string, unknown>) => void;

/** How long an adapter's own event id is remembered, so a resend runs once. */
const EVENT_DEDUPE_SECONDS = 24 * 3_600;

/** What a decision came to. A refusal's `reason` is one of the gate's reasons or one of this sink's; the words said back are fixed (`DECISION_REFUSAL_WORDS`). */
export type ChannelDecisionAnswer = { status: "decided" } | { status: "refused"; reason: string };

export interface ChannelWork {
  /** A message that passed every check. */
  message(item: { orgId: OrgId; message: InboundMessage; projectName: string; personId: string }): Promise<void>;
  /** A decision that passed every check and matches an open card. The seam asks the approval gate with a credential of this adapter's own method; the gate's Approvers decide whether that method is offered. */
  decide(item: { orgId: OrgId; card: ApprovalCard; decision: ChannelDecision; personId: string; projectName: string }): Promise<ChannelDecisionAnswer>;
}

export interface ChannelSinkDeps {
  /** The adapter's name in the registry. */
  channel: string;
  adapter: Pick<ChannelAdapter, "projects" | "stepUp" | "deliver">;
  store: DocumentStore;
  /** The company of an install that has one (Code): used when `companyOf` is not given. */
  orgId: OrgId;
  /** Which company a conversation's tenant belongs to; undefined: the tenant is nobody's here and the item runs nothing. Default: `orgId`, for every tenant. */
  companyOf?: ((where: { channel: string; tenant: string }) => OrgId | undefined | Promise<OrgId | undefined>) | undefined;
  /** Which person a chat account is, in a company; undefined: nobody (the account is told how to link). Default: the link the owner made (`linkedPerson`). */
  personOf?: ((orgId: OrgId, actor: ActorRef) => Promise<string | undefined>) | undefined;
  now: () => number;
  work: ChannelWork;
  /** The words that tell a person how to finish linking their account, given the code (the surface that redeems it is the work seam's owner). */
  linkWords: (code: string) => string;
  log?: Log;
}

export const DECISION_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  not_open: "That request is no longer open. Look at the task page for what waits for you.",
  stale: "That request has changed since it was posted. Look at the task page for the current version.",
  step_up: "This is decided on the task page, where you sign in. Open the task and decide there.",
  method_not_allowed: "A reply here is not enough to decide this. Open the task page and decide there.",
  not_approved: "A reply here is not enough to decide this. Open the task page and decide there.",
  not_waiting: "That is no longer waiting for an answer.",
  expired: "That request has expired. Look at the task page.",
};
const GENERIC_REFUSAL = "That could not be applied from here. Open the task page and decide there.";
export const decisionRefusalWords = (reason: string): string => DECISION_REFUSAL_WORDS[reason] ?? GENERIC_REFUSAL;

const sameConversation = (a: ConversationRef, b: ConversationRef): boolean => a.channel === b.channel && a.tenant === b.tenant && a.space === b.space && a.thread === b.thread;

export function createChannelSink(deps: ChannelSinkDeps): ChannelInboundSink {
  const log: Log = deps.log ?? ((entry) => console.log(JSON.stringify({ component: "channel", channel: deps.channel, ...entry })));
  const claimKey = (orgId: OrgId, name: string): DocumentKey => ({ pk: orgScoped(orgId, `CHANNEL_CLAIM#${deps.channel}/${name}`), sk: "CLAIM" });

  /** Takes a name for `seconds`; false when somebody holds it. An expired claim counts as free (the store deletes late). */
  async function claim(orgId: OrgId, name: string, seconds: number, scope: DocumentKey[]): Promise<boolean> {
    const nowSeconds = Math.floor(deps.now() / 1000);
    const key = claimKey(orgId, name);
    const result = await deps.store.put({
      item: { ...key, entityType: "CHANNEL_CLAIM", expiresAt: nowSeconds + seconds, [INDEX_EXPIRY_ATTRIBUTE]: nowSeconds + seconds },
      condition: when.or(when.absent(), when.lte("expiresAt", nowSeconds)),
    });
    if (result.applied) scope.push(key);
    return result.applied;
  }

  /** Says it; false when the send failed (the failure is logged by its name). */
  async function say(conversation: ConversationRef, type: "progress" | "error", text: string, onlyTo?: string): Promise<boolean> {
    const base = { version: 1 as const, id: channelEventId(), channel: deps.channel, conversation, createdAt: new Date(deps.now()).toISOString() };
    const event = (type === "progress" ? { ...base, type, data: { text, ...(onlyTo === undefined ? {} : { onlyTo }) } } : { ...base, type, data: { code: "not_applied", text } }) as ChannelEvent;
    try {
      await deps.adapter.deliver(event);
      return true;
    } catch (error) {
      log({ event: "channel.reply_failed", errorName: error instanceof Error ? error.name : "unknown" });
      return false;
    }
  }

  /** Queued already: a failed acknowledgement must not fail the call, or the adapter's retry would run the message twice. */
  async function acknowledge(conversation: ConversationRef, inReplyTo: string): Promise<void> {
    const event = { version: 1 as const, id: channelEventId(), channel: deps.channel, conversation, createdAt: new Date(deps.now()).toISOString(), type: "ack", data: { inReplyTo } } as ChannelEvent;
    try {
      await deps.adapter.deliver(event);
    } catch (error) {
      log({ event: "channel.ack_failed", errorName: error instanceof Error ? error.name : "unknown" });
    }
  }

  /** The checks both kinds share. Answers the company, the person and the project, or undefined when the item must run nothing. */
  async function admit(kind: "message" | "decision", item: { channel: string; eventId: string; conversation: ConversationRef; actor: ActorRef }, scope: DocumentKey[]): Promise<{ orgId: OrgId; personId: string; projectName: string } | undefined> {
    if (item.channel !== deps.channel || item.conversation.channel !== deps.channel || item.actor.channel !== deps.channel) { log({ event: "channel.refused", reason: "channel_mismatch" }); return undefined; }
    // An account of another workspace than the conversation's (a guest from a shared channel) is told nothing and given no code.
    if (item.actor.tenant !== item.conversation.tenant) { log({ event: "channel.refused", reason: "actor_tenant_mismatch" }); return undefined; }
    const orgId = deps.companyOf === undefined ? deps.orgId : await deps.companyOf({ channel: deps.channel, tenant: item.conversation.tenant });
    if (orgId === undefined) { log({ event: "channel.refused", reason: "company_unknown" }); return undefined; }
    const binding = await readChannelBinding({ store: deps.store, orgId }, { channel: item.conversation.channel, tenant: item.conversation.tenant, space: item.conversation.space }).catch(() => undefined);
    if (binding === undefined || !deps.adapter.projects.includes(binding.projectName)) { log({ event: "channel.refused", reason: "space_not_bound" }); return undefined; }
    const personId = await (deps.personOf?.(orgId, item.actor) ?? linkedPerson({ store: deps.store, orgId, now: deps.now }, item.actor));
    if (personId === undefined) {
      // One notice per person an hour. The code goes to that person alone: a code others can read is a code they can ask the owner to confirm. When the private send fails (the chat refused it, or could not show it to one person),
      // the hour's claim is freed, so the next mention sends it again instead of waiting an hour for a code nobody saw.
      // An unlinked account writes no event claim (a busy channel cannot grow the store by mentioning the bot), only this one row an hour.
      if (await claim(orgId, `LINK_NOTICE#${item.actor.tenant}/${item.actor.userId}`, LINK_REQUIRED_INTERVAL_SECONDS, scope)) {
        const { code } = await issueChannelLinkCode({ store: deps.store, orgId, now: deps.now }, item.actor);
        const sent = await say(item.conversation, "progress", `I don't know who you are in Rovara yet. ${deps.linkWords(code)}`, item.actor.userId);
        if (!sent) await deps.store.delete({ key: claimKey(orgId, `LINK_NOTICE#${item.actor.tenant}/${item.actor.userId}`) }).catch(() => undefined);
      }
      log({ event: "channel.link_required", kind });
      return undefined;
    }
    if (!(await claim(orgId, `EVENT#${kind}/${item.eventId}`, EVENT_DEDUPE_SECONDS, scope))) { log({ event: "channel.duplicate", kind }); return undefined; }
    return { orgId, personId, projectName: binding.projectName };
  }

  const release = async (scope: DocumentKey[]): Promise<void> => {
    for (const key of scope) await deps.store.delete({ key }).catch(() => undefined);
  };

  return {
    async message(raw) {
      const scope: DocumentKey[] = [];
      const parsed = InboundMessageSchema.safeParse(raw);
      if (!parsed.success) { log({ event: "channel.refused", reason: "invalid_message" }); return; }
      try {
        const who = await admit("message", parsed.data, scope);
        if (who === undefined) return;
        await deps.work.message({ message: parsed.data, ...who });
        await acknowledge(parsed.data.conversation, parsed.data.eventId);
      } catch (error) {
        await release(scope);
        log({ event: "channel.failed", kind: "message", errorName: error instanceof Error ? error.name : "unknown" });
        throw error;
      }
    },

    async decision(raw) {
      const scope: DocumentKey[] = [];
      const parsed = ChannelDecisionSchema.safeParse(raw);
      if (!parsed.success) { log({ event: "channel.refused", reason: "invalid_decision" }); return; }
      const decision = parsed.data;
      try {
        const who = await admit("decision", decision, scope);
        if (who === undefined) return;
        const card = await readApprovalCard({ store: deps.store, orgId: who.orgId, now: deps.now }, decision.requestId);
        if (card === undefined || card.channel !== deps.channel || !sameConversation(card.conversation, decision.conversation)) {
          log({ event: "channel.refused", reason: "not_open" });
          await say(decision.conversation, "error", decisionRefusalWords("not_open"));
          return;
        }
        if (card.revision !== decision.expectedRevision || card.artifactDigest !== decision.artifactDigest) {
          log({ event: "channel.refused", reason: "stale" });
          await say(decision.conversation, "error", decisionRefusalWords("stale"));
          return;
        }
        // A kind that asks for a sign-in is decided on the task page, whatever a message says; so is a decision the card did not offer.
        if (!adapterMayDecide({ stepUp: [...deps.adapter.stepUp] }, card.kind) || !card.offered.includes(decision.decision)) {
          log({ event: "channel.refused", reason: "step_up" });
          await say(decision.conversation, "error", decisionRefusalWords("step_up"));
          return;
        }
        const answer = await deps.work.decide({ card, decision, ...who });
        if (answer.status === "decided") await say(decision.conversation, "progress", "Recorded.");
        else {
          log({ event: "channel.refused", reason: answer.reason });
          await say(decision.conversation, "error", decisionRefusalWords(answer.reason));
        }
      } catch (error) {
        await release(scope);
        log({ event: "channel.failed", kind: "decision", errorName: error instanceof Error ? error.name : "unknown" });
        throw error;
      }
    },
  };
}
