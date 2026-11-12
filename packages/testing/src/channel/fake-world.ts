// The channel suite's world for the in-process fake adapter (`FakeChannelAdapter`). The fake records the events it is given, so what people "are shown" is read back from them, and a person
// speaks and presses by calling the sink the core handed to `start`. It has no workspace, no markup and no limits of its own: it promises only what the port asks, and the checks that need more are skipped.
import { FakeChannelAdapter } from "@agentx/broker/ports";
import type { ActorRef, ChannelDecision, ChannelEvent, ConversationRef } from "@agentx/contracts";
import type { ChannelPerson, ChannelWorld, ShownMessage, ShownRequest } from "./channel-conformance.js";

export const FAKE_CHANNEL_ID = "examplechat";

export interface FakeChannelWorldOptions {
  /** The tenant of the conversation and the account. Default `teamone`. */
  tenant?: string;
  /** The space, thread and account ids: the same raw ids may be used by two worlds. */
  space?: string;
  thread?: string;
  userId?: string;
  adapter?: FakeChannelAdapter;
}

/** The words a person is shown for an event ("" for one that says nothing in this tool). */
function textOf(event: ChannelEvent): string {
  switch (event.type) {
    case "ack": return "";
    case "pr": return `${event.data.title} ${event.data.url}`;
    case "done": return event.data.text ?? "";
    case "link_required": return event.data.linkUrl;
    case "direct": return event.data.text;
    case "question": return [event.data.text, ...(event.data.choices ?? [])].join("\n");
    default: return event.data.text;
  }
}

const onlyToOf = (event: ChannelEvent): string | undefined => {
  if (event.type === "progress") return event.data.onlyTo;
  if (event.type === "message" && event.data.audience?.kind === "ephemeral") return event.data.audience.actor.userId;
  return undefined;
};

function shownOf(event: ChannelEvent): ShownMessage | undefined {
  if (event.type === "direct") return undefined;
  const text = textOf(event);
  if (text === "") return undefined;
  const onlyTo = onlyToOf(event);
  const buttons = event.type !== "approval_request" ? [] : [
    ...(event.data.actions ?? []).map((action) => ({
      label: action.label, decision: action.decision,
      request: { requestId: event.data.requestId, expectedRevision: event.data.expectedRevision, artifactDigest: event.data.artifactDigest },
    })),
    ...(event.data.taskUrl === undefined ? [] : [{ label: "Open the task", opens: event.data.taskUrl }]),
  ];
  return { space: event.conversation.space, thread: event.conversation.thread, text, ...(onlyTo === undefined ? {} : { onlyTo }), buttons };
}

export function fakeChannelWorld(options: FakeChannelWorldOptions = {}): ChannelWorld {
  const adapter = options.adapter ?? new FakeChannelAdapter();
  const conversation: ConversationRef = { channel: FAKE_CHANNEL_ID, tenant: options.tenant ?? "teamone", space: options.space ?? "room1", thread: options.thread ?? "main" };
  const actor: ActorRef = { channel: FAKE_CHANNEL_ID, tenant: conversation.tenant, userId: options.userId ?? "user1" };
  let heard = 0;
  const cardOf = (request?: ShownRequest): ShownRequest => {
    const cards = adapter.delivered.filter((event) => event.type === "approval_request");
    const found = request !== undefined ? request : cards.at(-1) === undefined ? undefined : (() => { const data = (cards.at(-1) as Extract<ChannelEvent, { type: "approval_request" }>).data; return { requestId: data.requestId, expectedRevision: data.expectedRevision, artifactDigest: data.artifactDigest }; })();
    if (found === undefined) throw new Error("no card has been shown");
    return found;
  };
  const decide = async (decision: ChannelDecision["decision"], reason: string, request?: ShownRequest): Promise<void> => {
    const card = cardOf(request);
    heard += 1;
    await adapter.sink?.decision({
      version: 1, channel: FAKE_CHANNEL_ID, eventId: `press-${String(heard)}`, conversation, actor, ...card, decision, reason, receivedAt: "2026-11-10T10:00:00.000Z",
    });
  };
  const person: ChannelPerson = {
    listening: () => adapter.sink !== undefined,
    async say(text) {
      heard += 1;
      await adapter.sink?.message({ version: 2, channel: FAKE_CHANNEL_ID, eventId: `say-${String(heard)}`, conversation, actor, text, receivedAt: "2026-11-10T10:00:00.000Z" });
    },
    press: (decision, request) => decide(decision, "Pressed in chat.", request),
    requestChanges: (reason) => decide("REQUEST_CHANGES", reason),
  };
  return {
    adapter, channel: FAKE_CHANNEL_ID, conversation, actor, person,
    shown: async () => adapter.delivered.flatMap((event) => shownOf(event) ?? []),
    // The fake records what it is given: it takes any channel, shows any conversation and cuts nothing.
    promises: { otherChannel: false, cutsLongText: false, privateNotes: true },
    secrets: [], logs: () => [],
  };
}
