// Spec 062 Phase 7a (FR-070 to FR-072): rich messages, actions and commands, each behind a capability the adapter
// declares; the core sends nothing an adapter cannot show or keep private, and trusts no answer it did not ask for.
import { describe, expect, it, vi } from "vitest";
import {
  ChannelActionSchema, ChannelAdapterRegistrationSchema, ChannelCapabilitiesSchema, ChannelCommandSchema, ChannelEventSchema,
  adapterTakesCommand, channelEventId, generateWebhookSecret, verifyWebhook, webhookHeaders,
  type ChannelAdapterRecord, type ChannelEvent,
} from "@rovara-code/contracts";
import { EndpointRefused } from "@agentx/gateway";
import { sendChannelCommand, type ChannelCommandDependencies } from "../../packages/core/src/aws/channel-commands.js";
import { createChannelEventSender, fitEventToAdapter, unsendableReason } from "../../packages/core/src/aws/channel-events.js";

const NOW = Date.parse("2026-11-10T10:00:00.000Z");
const SECRET = generateWebhookSecret();
const conversation = { channel: "chatops", tenant: "T1", space: "S1", thread: "main" };
const actor = { channel: "chatops", tenant: "T1", userId: "U1" };
const baseCapabilities = { threads: true, buttons: 5, edits: true, maxTextLength: 4096, proactive: true };
const adapter = (capabilities: Partial<ChannelAdapterRecord["capabilities"]> = {}, commandsUrl: string | null = "https://adapter.example.com/commands"): ChannelAdapterRecord => ({
  channel: "chatops", callbackUrl: "https://adapter.example.com/events", ...(commandsUrl === null ? {} : { commandsUrl }),
  capabilities: ChannelCapabilitiesSchema.parse({ ...baseCapabilities, ...capabilities }),
  projects: ["web"], stepUp: [], secretName: "agentx/test/channel-adapter/chatops",
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "admin",
});
const message = (data: Record<string, unknown>): ChannelEvent => ChannelEventSchema.parse({
  version: 1, id: channelEventId(), channel: "chatops", conversation, createdAt: "2026-11-10T10:00:00.000Z", type: "message", data: { text: "The plan is ready.", ...data },
});

describe("rich messages (FR-070)", () => {
  it("carry parts, actions, a key and an audience, with plain text always there", () => {
    const event = message({
      key: "task:42:plan",
      parts: [{ type: "section", text: "*Plan* v2" }, { type: "fields", fields: [{ label: "Repository", value: "web" }] }, { type: "divider" }],
      actions: [
        { type: "button", actionId: "workflow.approve", value: "42", label: "Approve", style: "primary" },
        { type: "link", label: "Open the task", url: "https://rovara.example.com/review/42/task" },
        { type: "form", actionId: "workflow.changes", value: "42", label: "Request changes", form: { title: "Request changes", submitLabel: "Send", fields: [{ id: "note", label: "What should change?", kind: "multiline" }] } },
      ],
      audience: { kind: "ephemeral", actor },
    });
    expect(event.type).toBe("message");
  });

  it("refuse a select field without options, an unknown part, and a private message for another channel's actor", () => {
    const form = { title: "Who", submitLabel: "Save", fields: [{ id: "role", label: "Role", kind: "select" }] };
    expect(() => message({ actions: [{ type: "form", actionId: "people.set", value: "", label: "Set", form }] })).toThrow();
    expect(() => message({ parts: [{ type: "video", url: "https://x.example.com" }] })).toThrow();
    expect(() => message({ audience: { kind: "ephemeral", actor: { ...actor, channel: "other" } } })).toThrow();
  });

  it("can go to one person outside any conversation", () => {
    const direct = ChannelEventSchema.parse({ version: 1, id: channelEventId(), channel: "chatops", createdAt: "2026-11-10T10:00:00.000Z", type: "direct", to: actor, data: { text: "You were added to task 42." } });
    expect(direct.type).toBe("direct");
    expect(() => ChannelEventSchema.parse({ ...direct, to: { ...actor, channel: "other" } })).toThrow();
  });
});

describe("fitting an event to the adapter", () => {
  const withActions = message({ actions: [
    { type: "button", actionId: "a.one", value: "1", label: "One" },
    { type: "form", actionId: "a.form", value: "", label: "Form", form: { title: "T", submitLabel: "S", fields: [{ id: "x", label: "X", kind: "text" }] } },
  ] });

  it("drops form buttons for an adapter without forms, and every action past its buttons", () => {
    expect((fitEventToAdapter(withActions, adapter({ forms: false })) as Extract<ChannelEvent, { type: "message" }>).data.actions?.map((action) => action.type)).toEqual(["button"]);
    expect((fitEventToAdapter(withActions, adapter({ forms: true })) as Extract<ChannelEvent, { type: "message" }>).data.actions).toHaveLength(2);
    expect((fitEventToAdapter(withActions, adapter({ forms: true, buttons: 1 })) as Extract<ChannelEvent, { type: "message" }>).data.actions).toBeUndefined();
  });

  it("never sends a private or direct message to an adapter that cannot keep it private", async () => {
    const ephemeral = message({ audience: { kind: "ephemeral", actor } });
    expect(unsendableReason(ephemeral, adapter())).toBe("ephemeral_unsupported");
    expect(unsendableReason(ephemeral, adapter({ ephemeral: true }))).toBeUndefined();
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const sender = createChannelEventSender({ getAdapter: async () => adapter(), getSecret: async () => SECRET, fetch: fetchFn, checkAddresses: async () => undefined, now: () => NOW, log: () => undefined });
    expect(await sender({ Records: [{ messageId: "m", body: JSON.stringify(ephemeral) }] })).toEqual({ batchItemFailures: [] });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("code/next's one-person progress note (onlyTo)", () => {
  it("is never sent to an adapter that cannot keep it private, and is sent to one that can", async () => {
    const note = { ...message({}), type: "progress", data: { text: "Your link code is 123456.", onlyTo: actor.userId } } as ChannelEvent;
    expect(unsendableReason(note, adapter())).toBe("ephemeral_unsupported");
    expect(unsendableReason(note, adapter({ ephemeral: true }))).toBeUndefined();
    expect(unsendableReason({ ...note, data: { text: "Working." } } as ChannelEvent, adapter())).toBeUndefined();
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const sender = createChannelEventSender({ getAdapter: async () => adapter(), getSecret: async () => SECRET, fetch: fetchFn, checkAddresses: async () => undefined, now: () => NOW, log: () => undefined });
    expect(await sender({ Records: [{ messageId: "m", body: JSON.stringify(note) }] })).toEqual({ batchItemFailures: [] });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("actions (FR-071)", () => {
  it("carry the press or the form, for the adapter's own channel only", () => {
    const action = { version: 1, channel: "chatops", eventId: "a1", conversation, actor, actionId: "workflow.changes", value: "42", form: { note: "keep the old menu" }, messageKey: "task:42:plan", receivedAt: "2026-11-10T10:00:00.000Z" };
    expect(ChannelActionSchema.parse(action)).toEqual(action);
    expect(() => ChannelActionSchema.parse({ ...action, actor: { ...actor, channel: "other" } })).toThrow();
    expect(() => ChannelActionSchema.parse({ ...action, actionId: "Not An Id" })).toThrow();
  });
});

describe("capabilities", () => {
  it("leave the new ones off unless declared, so an older registration reads as before", () => {
    const registration = ChannelAdapterRegistrationSchema.parse({ callbackUrl: "https://adapter.example.com/events", capabilities: baseCapabilities, projects: ["web"] });
    expect(registration.capabilities).toEqual(baseCapabilities);
    expect(adapterTakesCommand(adapter(), "space_members")).toBe(false);
    expect(adapterTakesCommand(adapter({ directory: true }), "space_members")).toBe(true);
    expect(adapterTakesCommand(adapter({ directory: true }, null), "space_members")).toBe(false);
  });
});

describe("commands (FR-072)", () => {
  function deps(answer: (command: { id: string; kind: string }) => { status?: number; body: unknown; signAs?: string; secret?: string }, overrides: Partial<ChannelCommandDependencies> = {}) {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      sent.push({ url: url instanceof Request ? url.url : url.toString(), init: init! });
      const command = JSON.parse(init?.body as string) as { id: string; kind: string };
      const reply = answer(command);
      const body = JSON.stringify(reply.body);
      const headers = webhookHeaders({ secret: reply.secret ?? SECRET, id: reply.signAs ?? command.id, timestamp: NOW / 1000, body });
      return new Response(body, { status: reply.status ?? 200, headers });
    });
    return { sent, deps: { getSecret: async () => SECRET, fetch: fetchFn, checkAddresses: async () => undefined, now: () => NOW, ...overrides } satisfies ChannelCommandDependencies };
  }
  const directory = adapter({ directory: true, startConversations: true });

  it("sends a signed command and answers its checked result", async () => {
    const { sent, deps: d } = deps(() => ({ body: { ok: true, result: { members: ["U1", "U2"] } } }));
    expect(await sendChannelCommand(d, directory, "space_members", { tenant: "T1", space: "S1" })).toEqual({ members: ["U1", "U2"] });
    const { url, init } = sent[0]!;
    expect(url).toBe("https://adapter.example.com/commands");
    expect(init.redirect).toBe("manual");
    const command = ChannelCommandSchema.parse(JSON.parse(init.body as string));
    expect(command).toMatchObject({ kind: "space_members", channel: "chatops", tenant: "T1", space: "S1" });
    expect(verifyWebhook({ secret: SECRET, headers: init.headers as Record<string, string>, body: init.body as string, nowSeconds: NOW / 1000 })).toMatchObject({ ok: true, id: command.id });
  });

  it("answers the new thread of a started conversation", async () => {
    const { deps: d } = deps(() => ({ body: { ok: true, result: { thread: "1700000000.000100" } } }));
    expect(await sendChannelCommand(d, directory, "start_conversation", { tenant: "T1", space: "S1", message: { text: "Task 42 started." } })).toEqual({ thread: "1700000000.000100" });
  });

  it("refuses an answer signed for another command, or with another secret", async () => {
    await expect(sendChannelCommand(deps(() => ({ body: { ok: true, result: { members: [] } }, signAs: "cmd_someoneelse0000000000" })).deps, directory, "space_members", { tenant: "T1", space: "S1" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(sendChannelCommand(deps(() => ({ body: { ok: true, result: { members: [] } }, secret: generateWebhookSecret() })).deps, directory, "space_members", { tenant: "T1", space: "S1" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a kind the adapter does not declare, without calling it", async () => {
    const { sent, deps: d } = deps(() => ({ body: { ok: true, result: {} } }));
    await expect(sendChannelCommand(d, directory, "create_document", { tenant: "T1", space: "S1", title: "Plan", markdown: "# Plan" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(sent).toEqual([]);
  });

  it.each([
    ["an error answer", { body: { ok: false, error: { code: "channel_not_found", message: "no such channel" } } }],
    ["a non-200", { status: 500, body: { ok: true, result: {} } }],
    ["an unreadable result", { body: { ok: true, result: { members: "everyone" } } }],
  ])("fails on %s", async (_name, reply) => {
    await expect(sendChannelCommand(deps(() => reply).deps, directory, "space_members", { tenant: "T1", space: "S1" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("refuses a commands URL that resolves to a private address", async () => {
    const { sent, deps: d } = deps(() => ({ body: { ok: true, result: { members: [] } } }), { checkAddresses: async () => { throw new EndpointRefused("private"); } });
    await expect(sendChannelCommand(d, directory, "space_members", { tenant: "T1", space: "S1" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(sent).toEqual([]);
  });
});
