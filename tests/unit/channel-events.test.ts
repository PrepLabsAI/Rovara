// Spec 062 FR-022, FR-023: events reach the adapter signed, at least once, shaped to what it can show.
import { describe, expect, it, vi } from "vitest";
import { channelEventId, generateWebhookSecret, verifyWebhook, type ChannelAdapterRecord, type ChannelEvent } from "@agentx/contracts";
import { EndpointRefused } from "@agentx/gateway";
import { createChannelEventSender, fitEventToAdapter, type ChannelEventSenderDependencies } from "../../packages/broker/src/aws/channel-events.js";

const NOW = Date.parse("2026-11-08T10:00:00.000Z");
const secret = generateWebhookSecret();
const conversation = { channel: "whatsapp", tenant: "+14155550100", space: "group=AbC-12_x", thread: "main" };
const adapter: ChannelAdapterRecord = {
  channel: "whatsapp", callbackUrl: "https://adapter.example.com/rovara",
  capabilities: { threads: false, buttons: 3, edits: false, maxTextLength: 200, proactive: false },
  projects: ["web"], stepUp: ["plan_approval"], secretName: "agentx/test/channel-adapter/whatsapp",
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "admin",
};
const done: ChannelEvent = { version: 1, id: channelEventId(), channel: "whatsapp", conversation, createdAt: "2026-11-08T10:00:00.000Z", type: "done", data: { text: "Opened a pull request." } };
const approval = (kind: "plan_approval" | "other"): ChannelEvent => ({
  version: 1, id: channelEventId(), channel: "whatsapp", conversation, createdAt: "2026-11-08T10:00:00.000Z", type: "approval_request",
  data: { text: "The plan is ready.", kind, requestId: "7f1c2a4e-9b0d-4c3e-8a5f-1d2e3f4a5b6c", expectedRevision: 3, artifactDigest: "a".repeat(64),
    taskUrl: "https://rovara.example.com/review/7f1c2a4e-9b0d-4c3e-8a5f-1d2e3f4a5b6c/task", actions: [{ decision: "APPROVE", label: "Approve" }] },
});

function setup(overrides: Partial<ChannelEventSenderDependencies> = {}, status = 200) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => { sent.push({ url: String(url), init: init! }); return new Response(null, { status }); });
  const delay = vi.fn(async () => undefined);
  const send = createChannelEventSender({
    getAdapter: async (channel) => (channel === "whatsapp" ? adapter : undefined),
    getSecret: async () => secret,
    fetch: fetchMock as unknown as typeof fetch,
    checkAddresses: async () => undefined,
    delay,
    now: () => NOW,
    log: () => undefined,
    ...overrides,
  });
  const run = (event: ChannelEvent | string, receives = "1") =>
    send({ Records: [{ messageId: "m1", body: typeof event === "string" ? event : JSON.stringify(event), receiptHandle: "r1", attributes: { ApproximateReceiveCount: receives } }] });
  return { run, sent, fetchMock, delay };
}

describe("delivery", () => {
  it("posts the event signed with the adapter's secret, its id as webhook-id, without following redirects", async () => {
    const { run, sent } = setup();
    expect(await run(done)).toEqual({ batchItemFailures: [] });
    expect(sent).toHaveLength(1);
    const { url, init } = sent[0]!;
    expect(url).toBe("https://adapter.example.com/rovara");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers["webhook-id"]).toBe(done.id);
    expect(verifyWebhook({ secret, headers, body: init.body as string, nowSeconds: NOW / 1000 }).ok).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual(done);
  });

  it.each([[500], [503], [429], [408]])("retries a %i with a growing delay", async (status) => {
    const { run, delay } = setup({}, status);
    expect(await run(done, "3")).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(delay).toHaveBeenCalledWith("r1", 40);
  });

  it("retries a network failure, an unreadable secret and an unresolved host", async () => {
    expect((await setup({ fetch: (async () => { throw new TypeError("fetch failed"); }) }).run(done)).batchItemFailures).toHaveLength(1);
    expect((await setup({ getSecret: async () => undefined }).run(done)).batchItemFailures).toHaveLength(1);
    expect((await setup({ checkAddresses: async () => { throw new Error("ENOTFOUND"); } }).run(done)).batchItemFailures).toHaveLength(1);
  });

  it("caps the delay at 15 minutes", async () => {
    const { run, delay } = setup({}, 500);
    await run(done, "20");
    expect(delay).toHaveBeenCalledWith("r1", 900);
  });

  it.each([
    ["a 400", setup({}, 400)],
    ["a redirect", setup({}, 302)],
    ["a callback that resolves to a private address", setup({ checkAddresses: async () => { throw new EndpointRefused("private"); } })],
    ["an adapter since removed", setup({ getAdapter: async () => undefined })],
  ])("drops the event on %s", async (_name, harness) => {
    expect(await harness.run(done)).toEqual({ batchItemFailures: [] });
  });

  it("drops a malformed event without sending it", async () => {
    const { run, fetchMock } = setup();
    expect(await run("not json")).toEqual({ batchItemFailures: [] });
    expect(await run(JSON.stringify({ ...done, channel: "slack" }))).toEqual({ batchItemFailures: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("shaping (FR-023)", () => {
  it("cuts text to the adapter's limit", () => {
    const long = { ...done, data: { text: "x".repeat(500) } } as ChannelEvent;
    const fitted = fitEventToAdapter(long, adapter);
    expect((fitted.data as { text: string }).text).toHaveLength(200);
    expect((fitted.data as { text: string }).text.endsWith("…")).toBe(true);
  });

  it("strips approve actions from a stepped-up kind and keeps the task page link even when cut", () => {
    const event = approval("plan_approval");
    const long = { ...event, data: { ...event.data, text: "y".repeat(500) } } as ChannelEvent;
    const fitted = fitEventToAdapter(long, adapter) as Extract<ChannelEvent, { type: "approval_request" }>;
    expect(fitted.data.actions).toBeUndefined();
    expect(fitted.data.text.endsWith(`Approve on the task page: ${fitted.data.taskUrl}`)).toBe(true);
    expect(fitted.data.text.length).toBeLessThanOrEqual(200);
  });

  it("keeps actions on a kind the adapter does not step up", () => {
    const fitted = fitEventToAdapter(approval("other"), adapter) as Extract<ChannelEvent, { type: "approval_request" }>;
    expect(fitted.data.actions).toEqual([{ decision: "APPROVE", label: "Approve" }]);
  });
});
