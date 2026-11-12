// The channel contract: a chat tool as an ordinary `channel` adapter (owner decision 58). Rovara's events go out as messages in the conversation they name, and what people say comes back through the sink the core hands to
// `start`. The adapter is trusted to say what it heard, never for who may do what, so the suite checks the two things an adapter owns: that every event is shown to the people it is for and no others, with exactly the buttons
// it declared, and that what it hears is neutral (a message, or a decision for exactly the request a card named).
//
// A suite is a list of named checks over a `ChannelWorld`: the adapter under test, a window on what the chat tool shows people (`shown`), and, for an adapter that listens, a `person` who speaks and presses buttons in
// the tool. A world gives only what its adapter can do; a check that needs more shows as skipped. A real adapter runs the same suite over a fake of the tool's network (see `slack-world.ts`): the adapter is real, the tool is not.
import { expect } from "vitest";
import {
  ChannelCapabilitiesSchema, ChannelEventSchema, InboundMessageSchema, StepUpKindSchema, ChannelDecisionSchema,
  type ActorRef, type ChannelAdapter, type ChannelDecision, type ChannelEvent, type ChannelInboundSink, type ConversationRef, type InboundMessage,
} from "@agentx/contracts";
import { twoCompanyChecks, type TwoCompanyIsolation } from "../isolation/two-company.js";
import { assertNoSecretLeaks } from "../isolation/leaks.js";
import { rejection, type ContractCheck } from "../ports/plugin-contract-kit.js";

/** What a button on a card answers: the exact request it names. */
export interface ShownRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly artifactDigest: string;
}

export interface ShownButton {
  readonly label: string;
  /** The decision a press answers. Absent for a button that only opens an address. */
  readonly decision?: ChannelDecision["decision"];
  readonly request?: ShownRequest;
  readonly opens?: string;
}

/** One message people see in the tool. */
export interface ShownMessage {
  readonly space: string;
  /** Absent: at the top of the space. */
  readonly thread?: string;
  readonly text: string;
  /** The account that alone sees it. Absent: everyone in the conversation. */
  readonly onlyTo?: string;
  readonly buttons: readonly ShownButton[];
}

/** A person in the tool, who speaks and presses buttons. Only an adapter that listens has one. */
export interface ChannelPerson {
  /** Whether the adapter's connection to the tool is open now. */
  listening(): boolean;
  /** The person mentions Rovara in the conversation with `text` (the world adds whatever makes it a mention). */
  say(text: string): Promise<void>;
  /** Something said in the conversation that is not addressed to Rovara: Rovara's own words, another app's, a plain reply. Nothing the adapter hears from it may reach the sink. */
  saysUnaddressed?(text: string): Promise<void>;
  /** The person presses the button of `decision` on the latest card, or, when `request` is given, on a card that names that request. */
  press(decision: ChannelDecision["decision"], request?: ShownRequest): Promise<void>;
  /** The person presses Request changes and types `reason` in the box it opens. */
  requestChanges?(reason: string): Promise<void>;
}

export interface ChannelWorld {
  /** Two companies' chat tools sharing raw ids on this adapter, for the isolation kit. Absent: the adapter serves one company, and those checks show as skipped. */
  readonly isolation?: TwoCompanyIsolation;
  readonly adapter: ChannelAdapter;
  /** The channel id the adapter's events and conversations carry. */
  readonly channel: string;
  /** A conversation the adapter may post in, and an account of its tenant. */
  readonly conversation: ConversationRef;
  readonly actor: ActorRef;
  /** A conversation of a workspace the adapter is not installed in. Absent: the tool has no such notion. */
  readonly foreignConversation?: ConversationRef;
  /** What people have been shown so far, in order. */
  shown(): Promise<readonly ShownMessage[]>;
  readonly person?: ChannelPerson;
  /** What this adapter promises beyond the port's minimum; each is a check that shows as skipped when false. */
  readonly promises: { readonly otherChannel: boolean; readonly cutsLongText: boolean; readonly privateNotes: boolean };
  /** A string the tool reads as syntax (a mention of everyone): Rovara's text must not reach people holding it raw. */
  readonly markup?: string;
  /** The next send fails, as the tool's own outage or refusal would. */
  failNextSend?(): void;
  /** Values that must never appear in an error, a log line or anything shown (tokens). Planted by the world at run time. */
  readonly secrets: readonly string[];
  /** What the adapter logged. */
  logs(): readonly string[];
  /** The credentials the tool has received on this adapter's behalf, as the tool saw them (headers). Absent: the tool is not modelled that far. */
  seenCredentials?(): readonly string[];
}

let counter = 0;
const next = (): number => { counter += 1; return counter; };
const eventId = (): string => `evt_conformance_${String(next()).padStart(8, "0")}`;
const uuid = (): string => `3f2504e0-4f89-41d3-9a0c-${String(next()).padStart(12, "0")}`;
const CREATED_AT = "2026-11-10T10:00:00.000Z";

type Data<T extends ChannelEvent["type"]> = Extract<ChannelEvent, { type: T }>["data"];
export function channelEvent<T extends Exclude<ChannelEvent["type"], "direct">>(world: Pick<ChannelWorld, "channel" | "conversation">, type: T, data: Data<T>, overrides: { id?: string; conversation?: ConversationRef; channel?: string } = {}): ChannelEvent {
  return ChannelEventSchema.parse({
    version: 1, id: overrides.id ?? eventId(), channel: overrides.channel ?? world.channel, conversation: overrides.conversation ?? world.conversation, createdAt: CREATED_AT, type, data,
  });
}

/** A card's data, the way the core makes one: a request, its revision and digest, and the decisions it offers. */
export function approvalData(decisions: readonly ChannelDecision["decision"][], text = "A plan waits for you."): Data<"approval_request"> {
  return {
    text, kind: "other", requestId: uuid(), expectedRevision: 3, artifactDigest: "d".repeat(64), taskUrl: "https://example.test/tasks/1",
    actions: decisions.map((decision) => ({ decision, label: { APPROVE: "Approve", REQUEST_CHANGES: "Request changes", REJECT: "Reject", SKIP: "Skip" }[decision] })),
  };
}

const unique = (what: string): string => `${what}-${String(next())}-conformance`;
const inConversation = (world: ChannelWorld, shown: readonly ShownMessage[]): readonly ShownMessage[] => shown.filter((message) => message.space === world.conversation.space);

/** Waits (briefly) for what the tool delivers asynchronously. */
export async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check(), what).toBe(true);
}

export interface RecordingSink {
  readonly sink: ChannelInboundSink;
  readonly messages: InboundMessage[];
  readonly decisions: ChannelDecision[];
}
export function recordingSink(): RecordingSink {
  const messages: InboundMessage[] = [];
  const decisions: ChannelDecision[] = [];
  return { messages, decisions, sink: { message: async (message) => { messages.push(message); }, decision: async (decision) => { decisions.push(decision); } } };
}

/** Runs `body` with the adapter listening to a recording sink, and always stops it. */
async function listening<T>(world: ChannelWorld, body: (heard: RecordingSink) => Promise<T>): Promise<T> {
  const heard = recordingSink();
  const running = await world.adapter.start!(heard.sink);
  try {
    return await body(heard);
  } finally {
    await running.stop();
  }
}

const hears: ContractCheck<ChannelWorld>["needs"] = (world) => world.person !== undefined && world.adapter.start !== undefined;

const ownChecks: readonly ContractCheck<ChannelWorld>[] = [
  {
    name: "advertises capabilities that fit the schema, the projects it serves and the step-up kinds it keeps",
    async run({ adapter }) {
      expect(ChannelCapabilitiesSchema.safeParse(adapter.capabilities).success).toBe(true);
      expect(adapter.projects.length).toBeGreaterThan(0);
      expect(new Set(adapter.projects).size).toBe(adapter.projects.length);
      for (const kind of adapter.stepUp) expect(StepUpKindSchema.safeParse(kind).success).toBe(true);
    },
  },
  {
    name: "says what Rovara's events say, in the conversation they name: a message, progress, a question, a check report, a pull request, an error and a closing line",
    async run(world) {
      const texts = Object.fromEntries(["message", "progress", "question", "check_report", "pr", "error", "done"].map((type) => [type, unique(type)]));
      const events = [
        channelEvent(world, "message", { text: texts["message"]! }),
        channelEvent(world, "progress", { text: texts["progress"]! }),
        channelEvent(world, "question", { text: texts["question"]!, choices: ["first", "second"] }),
        channelEvent(world, "check_report", { text: texts["check_report"]!, status: "passed" }),
        channelEvent(world, "pr", { url: "https://example.test/pulls/9", title: texts["pr"]! }),
        channelEvent(world, "error", { code: "not_applied", text: texts["error"]! }),
        channelEvent(world, "done", { text: texts["done"]! }),
      ];
      for (const event of events) await world.adapter.deliver(event);
      const shown = inConversation(world, await world.shown());
      for (const [type, text] of Object.entries(texts)) {
        const found = shown.filter((message) => message.text.includes(text));
        expect(found.length, `${type} was shown once`).toBe(1);
        expect(found[0]!.onlyTo, `${type} is for everyone in the conversation`).toBeUndefined();
        expect(found[0]!.thread, `${type} is in the thread it names`).toBe(world.conversation.thread);
      }
    },
  },
  {
    name: "shows an approval request with its words, a button for each decision it can show, and exactly the request each button names",
    async run(world) {
      const data = approvalData(["APPROVE", "REJECT"]);
      await world.adapter.deliver(channelEvent(world, "approval_request", data));
      const card = inConversation(world, await world.shown()).find((message) => message.text.includes(data.text));
      expect(card, "the card was shown").toBeDefined();
      if (world.adapter.capabilities.buttons === 0) return;
      const decisions = card!.buttons.filter((button) => button.decision !== undefined);
      for (const decision of ["APPROVE", "REJECT"] as const) {
        const button = decisions.find((entry) => entry.decision === decision);
        expect(button, `a button for ${decision}`).toBeDefined();
        expect(button!.request, `the button for ${decision} names the request`).toEqual({ requestId: data.requestId, expectedRevision: data.expectedRevision, artifactDigest: data.artifactDigest });
      }
    },
  },
  {
    name: "drops a repeat of an event id: at least once is never twice",
    async run(world) {
      const text = unique("repeat");
      const event = channelEvent(world, "progress", { text });
      await world.adapter.deliver(event);
      await world.adapter.deliver(structuredClone(event));
      expect(inConversation(world, await world.shown()).filter((message) => message.text.includes(text))).toHaveLength(1);
    },
  },
  {
    name: "shows a note meant for one account to that account alone",
    needs: (world) => world.promises.privateNotes,
    async run(world) {
      const text = unique("private");
      await world.adapter.deliver(channelEvent(world, "progress", { text, onlyTo: world.actor.userId }));
      const found = inConversation(world, await world.shown()).filter((message) => message.text.includes(text));
      expect(found).toHaveLength(1);
      expect(found[0]!.onlyTo).toBe(world.actor.userId);
    },
  },
  {
    name: "refuses an event that is for another channel, and shows nothing",
    needs: (world) => world.promises.otherChannel,
    async run(world) {
      const text = unique("other-channel");
      const before = (await world.shown()).length;
      const other = ChannelEventSchema.parse({
        version: 1, id: eventId(), channel: "otherchat", createdAt: CREATED_AT, type: "progress", data: { text },
        conversation: { channel: "otherchat", tenant: "other-tenant", space: "other-space", thread: "other-thread" },
      });
      expect(await rejection(() => world.adapter.deliver(other))).toBeDefined();
      expect(await world.shown()).toHaveLength(before);
    },
  },
  {
    name: "refuses a conversation of a workspace it is not installed in, and shows nothing there",
    needs: (world) => world.foreignConversation !== undefined,
    async run(world) {
      const text = unique("foreign");
      const before = (await world.shown()).length;
      expect(await rejection(() => world.adapter.deliver(channelEvent(world, "progress", { text }, { conversation: world.foreignConversation! })))).toBeDefined();
      const shown = await world.shown();
      expect(shown).toHaveLength(before);
      expect(JSON.stringify(shown)).not.toContain(text);
    },
  },
  {
    name: "keeps the tool's own markup out of what Rovara says: a task's words cannot mention everyone",
    needs: (world) => world.markup !== undefined,
    async run(world) {
      const text = `${unique("markup")} ${world.markup!} please look`;
      await world.adapter.deliver(channelEvent(world, "progress", { text }));
      const found = inConversation(world, await world.shown()).filter((message) => message.text.includes("-conformance"));
      expect(found.length).toBeGreaterThan(0);
      for (const message of found) expect(message.text.includes(world.markup!), "the markup arrived raw").toBe(false);
    },
  },
  {
    name: "cuts a text that is longer than the adapter takes to the length it says",
    needs: (world) => world.promises.cutsLongText,
    async run(world) {
      const text = `${unique("long")} ${"x".repeat(world.adapter.capabilities.maxTextLength + 500)}`;
      await world.adapter.deliver(channelEvent(world, "progress", { text: text.slice(0, 40_000) }));
      const found = inConversation(world, await world.shown()).filter((message) => message.text.includes("-conformance"));
      expect(found.length).toBeGreaterThan(0);
      for (const message of found) expect([...message.text].length).toBeLessThanOrEqual(world.adapter.capabilities.maxTextLength);
    },
  },
  {
    name: "does not take an event it failed to send as sent: the retry shows it once",
    needs: (world) => world.failNextSend !== undefined,
    async run(world) {
      const text = unique("retry");
      const event = channelEvent(world, "progress", { text });
      world.failNextSend!();
      expect(await rejection(() => world.adapter.deliver(event))).toBeDefined();
      expect(inConversation(world, await world.shown()).filter((message) => message.text.includes(text))).toHaveLength(0);
      await world.adapter.deliver(structuredClone(event));
      expect(inConversation(world, await world.shown()).filter((message) => message.text.includes(text))).toHaveLength(1);
    },
  },
  {
    name: "says nothing a credential could be read from when a send fails: not in the error, not in the log, not in what people were shown",
    needs: (world) => world.failNextSend !== undefined && world.secrets.length > 0,
    async run(world) {
      world.failNextSend!();
      const failure = await rejection(() => world.adapter.deliver(channelEvent(world, "progress", { text: unique("secret") })));
      expect(failure).toBeDefined();
      await world.adapter.deliver(channelEvent(world, "progress", { text: unique("secret-after") }));
      assertNoSecretLeaks([failure, world.logs(), await world.shown()], world.secrets);
    },
  },
  {
    name: "hears a person's mention as a neutral message: the channel, the conversation, the account and the words, and nothing else",
    needs: hears,
    async run(world) {
      await listening(world, async (heard) => {
        const words = unique("add a retry");
        await world.person!.say(words);
        await until(() => heard.messages.length === 1, "the message reached the sink");
        const message = heard.messages[0]!;
        expect(InboundMessageSchema.safeParse(message).success).toBe(true);
        expect(message.channel).toBe(world.channel);
        expect(message.conversation).toMatchObject({ channel: world.channel, tenant: world.conversation.tenant, space: world.conversation.space });
        expect(message.actor).toEqual(world.actor);
        expect(message.text).toBe(words);
        expect(heard.decisions).toEqual([]);
      });
    },
  },
  {
    name: "hears nothing that is not addressed to Rovara",
    needs: (world) => hears(world) && world.person?.saysUnaddressed !== undefined,
    async run(world) {
      await listening(world, async (heard) => {
        await world.person!.saysUnaddressed!(unique("a plain reply"));
        // A message that is addressed comes after it: when this one has arrived, the unaddressed one had its chance.
        await world.person!.say(unique("addressed"));
        await until(() => heard.messages.length >= 1, "the addressed message reached the sink");
        expect(heard.messages).toHaveLength(1);
        expect(heard.messages[0]!.text).toContain("addressed");
      });
    },
  },
  {
    name: "hears a press of a card's button as a decision for exactly the request the card named, and decides nothing itself",
    needs: (world) => hears(world) && world.adapter.capabilities.buttons > 0,
    async run(world) {
      await listening(world, async (heard) => {
        const data = approvalData(["APPROVE", "REJECT"]);
        await world.adapter.deliver(channelEvent(world, "approval_request", data));
        await world.person!.press("REJECT");
        await until(() => heard.decisions.length === 1, "the press reached the sink");
        const decision = heard.decisions[0]!;
        expect(ChannelDecisionSchema.safeParse(decision).success).toBe(true);
        expect(decision).toMatchObject({ channel: world.channel, requestId: data.requestId, expectedRevision: data.expectedRevision, artifactDigest: data.artifactDigest, decision: "REJECT" });
        expect(decision.actor).toEqual(world.actor);
        expect(decision.conversation).toMatchObject({ tenant: world.conversation.tenant, space: world.conversation.space });
        expect(heard.messages).toEqual([]);
      });
    },
  },
  {
    name: "carries the person's own words as the reason of a request for changes",
    needs: (world) => hears(world) && world.person?.requestChanges !== undefined,
    async run(world) {
      await listening(world, async (heard) => {
        const data = approvalData(["APPROVE", "REQUEST_CHANGES"]);
        await world.adapter.deliver(channelEvent(world, "approval_request", data));
        const reason = unique("split the migration");
        await world.person!.requestChanges!(reason);
        await until(() => heard.decisions.length === 1, "the request for changes reached the sink");
        expect(heard.decisions[0]).toMatchObject({ decision: "REQUEST_CHANGES", reason, requestId: data.requestId, expectedRevision: data.expectedRevision, artifactDigest: data.artifactDigest });
      });
    },
  },
  {
    name: "stops listening when it is stopped: the connection closes and nothing more reaches the sink",
    needs: hears,
    async run(world) {
      const heard = recordingSink();
      const running = await world.adapter.start!(heard.sink);
      await until(() => world.person!.listening(), "the adapter started listening");
      await running.stop();
      expect(world.person!.listening()).toBe(false);
      await world.person!.say(unique("after stop"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(heard.messages).toEqual([]);
    },
  },
];

export const channelChecks: readonly ContractCheck<ChannelWorld>[] = [...ownChecks, ...twoCompanyChecks<ChannelWorld>()];
