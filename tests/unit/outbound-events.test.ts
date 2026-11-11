// Port lane P6 (item R3, owner decisions 40 and 61): the `outbound-events` point, in the same signed format as the channel events.
import { describe, expect, it } from "vitest";
import {
  CHANNEL_EVENT_TYPES,
  CODE_MILESTONE_KINDS,
  OUTBOUND_EVENT_DATA_MAX_BYTES,
  OUTBOUND_MILESTONE_EVENT_TYPES,
  OutboundEventSchema,
  PLUGIN_POINTS,
  PLUGIN_POINT_CARDINALITY,
  channelEventId,
  generateWebhookSecret,
  outboundEventId,
  outboundEventTypeOfMilestone,
  signOutboundEvent,
  signWebhook,
  verifyOutboundEvent,
  verifyWebhook,
  type OutboundEvent,
  type OutboundEventInput,
  type OutboundEventsAdapter,
  type PluginModule,
} from "@agentx/contracts";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, publishOutboundEvent, type ModuleImporter } from "../../packages/broker/src/ports/index.js";

const NOW = 1_800_000_000;
const SECRET = generateWebhookSecret();
const event = (extra: Partial<OutboundEventInput> = {}): OutboundEventInput => ({
  version: 1, id: outboundEventId(), type: "task.plan_ready", company: "org_aaaaaaaaaaaaaaaaaaaa", project: "demo", subject: { kind: "task", id: "task-1" }, createdAt: "2026-11-10T00:00:00.000Z",
  data: { revision: 3 }, artifacts: [{ kind: "plan", id: "plan-1", digest: "a".repeat(64), url: "https://rovara.example.test/tasks/task-1/plan" }], ...extra,
});

describe("the outbound-events point", () => {
  it("is a registered plug-in point that holds many adapters", () => {
    expect(PLUGIN_POINTS).toContain("outbound-events");
    expect(PLUGIN_POINT_CARDINALITY["outbound-events"]).toBe("many");
  });

  it("does not make points of realtime push or email (names only until something needs them)", () => {
    for (const name of ["realtime", "email"]) expect(PLUGIN_POINTS as readonly string[]).not.toContain(name);
  });
});

describe("an outbound event", () => {
  it("has the envelope of a channel event: version, an evt_ id that is stable across retries, and a time", () => {
    expect(outboundEventId()).toMatch(/^evt_[A-Za-z0-9_-]{16,64}$/);
    expect(channelEventId()).toMatch(/^evt_/);
    expect(OutboundEventSchema.parse(event())).toMatchObject({ version: 1, type: "task.plan_ready" });
  });

  it("defaults data and artifacts to empty, and refuses unknown fields", () => {
    const parsed = OutboundEventSchema.parse({ version: 1, id: outboundEventId(), type: "task.started", company: "c", createdAt: "2026-11-10T00:00:00.000Z" });
    expect(parsed.data).toEqual({});
    expect(parsed.artifacts).toEqual([]);
    expect(OutboundEventSchema.safeParse({ ...event(), extra: 1 }).success).toBe(false);
  });

  it("refuses a bad type, a bad id, a document-sized data, and an artifact reference with a credential in its link", () => {
    expect(OutboundEventSchema.safeParse(event({ type: "PlanReady" })).success).toBe(false);
    expect(OutboundEventSchema.safeParse(event({ id: "not-an-id" })).success).toBe(false);
    expect(OutboundEventSchema.safeParse(event({ data: { text: "x".repeat(OUTBOUND_EVENT_DATA_MAX_BYTES) } })).success).toBe(false);
    // data is FLAT: a nested object or a list is not a value.
    expect(OutboundEventSchema.safeParse(event({ data: { nested: { a: 1 } } as never })).success).toBe(false);
    expect(OutboundEventSchema.safeParse(event({ data: { list: [1, 2] } as never })).success).toBe(false);
    expect(OutboundEventSchema.safeParse(event({ data: { s: "x", n: 1, b: true, z: null } })).success).toBe(true);
    expect(OutboundEventSchema.safeParse(event({ artifacts: [{ kind: "plan", id: "p", url: "https://user:pw@example.test/x" }] })).success).toBe(false);
    expect(OutboundEventSchema.safeParse(event({ artifacts: [{ kind: "plan", id: "p", url: "http://example.test/x" }] })).success).toBe(false);
    expect(OutboundEventSchema.safeParse(event({ artifacts: Array.from({ length: 51 }, (_, i) => ({ kind: "plan", id: `p${String(i)}` })) })).success).toBe(false);
  });

  it("names a task milestone as task.<milestone>, for all eleven", () => {
    expect(outboundEventTypeOfMilestone("plan_ready")).toBe("task.plan_ready");
    expect(OUTBOUND_MILESTONE_EVENT_TYPES).toHaveLength(CODE_MILESTONE_KINDS.length);
    for (const type of OUTBOUND_MILESTONE_EVENT_TYPES) expect(OutboundEventSchema.safeParse(event({ type })).success, type).toBe(true);
  });
});

describe("signing: one protocol with the channel events", () => {
  it("sends the three Standard Webhooks headers, with the event's id as webhook-id, and a body a channel-event verifier accepts", () => {
    const input = event();
    const { body, headers } = signOutboundEvent({ secret: SECRET, event: input, timestamp: NOW });
    expect(headers["webhook-id"]).toBe(input.id);
    expect(headers["webhook-timestamp"]).toBe(String(NOW));
    expect(headers["webhook-signature"]).toMatch(/^v1,/);
    // The very function that checks a channel event's signature checks this one.
    expect(verifyWebhook({ secret: SECRET, headers, body, nowSeconds: NOW })).toEqual({ ok: true, id: input.id, timestamp: NOW });
    expect(headers["webhook-signature"]).toBe(signWebhook({ secret: SECRET, id: input.id, timestamp: NOW, body }));
  });

  it("is verified by a receiver, which gets the event back", () => {
    const { body, headers } = signOutboundEvent({ secret: SECRET, event: event(), timestamp: NOW });
    const verified = verifyOutboundEvent({ secret: SECRET, headers, body, nowSeconds: NOW + 10 });
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.event.artifacts[0]?.kind).toBe("plan");
  });

  it("is refused for a changed body, a wrong secret, a stale time, missing headers, a body that is not an event, and an id that does not match the header", () => {
    const signed = signOutboundEvent({ secret: SECRET, event: event(), timestamp: NOW });
    const check = (change: Partial<{ secret: string; headers: Record<string, string | undefined>; body: string; nowSeconds: number }>) => verifyOutboundEvent({ secret: SECRET, headers: signed.headers, body: signed.body, nowSeconds: NOW, ...change });
    expect(check({ body: signed.body.replace("task.plan_ready", "task.merged") })).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(check({ secret: generateWebhookSecret() })).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(check({ nowSeconds: NOW + 3_600 })).toMatchObject({ ok: false, reason: "stale_timestamp" });
    expect(check({ headers: {} })).toMatchObject({ ok: false, reason: "missing_headers" });
    // A correctly signed body that is not an outbound event.
    const notEvent = JSON.stringify({ hello: "world" });
    const id = outboundEventId();
    const headers = signOutboundEvent({ secret: SECRET, event: event({ id }), timestamp: NOW }).headers;
    const forged = { "webhook-id": id, "webhook-timestamp": String(NOW), "webhook-signature": signWebhook({ secret: SECRET, id, timestamp: NOW, body: notEvent }) };
    expect(check({ headers: forged, body: notEvent })).toMatchObject({ ok: false, reason: "bad_event" });
    // Signed with another event's id in the header: the header and the body disagree.
    const otherId = outboundEventId();
    const mismatched = { "webhook-id": otherId, "webhook-timestamp": String(NOW), "webhook-signature": signWebhook({ secret: SECRET, id: otherId, timestamp: NOW, body: signed.body }) };
    expect(check({ headers: mismatched })).toMatchObject({ ok: false, reason: "id_mismatch" });
    expect(headers["webhook-id"]).toBe(id);
  });

  it("does not sign an event that is not valid", () => {
    expect(() => signOutboundEvent({ secret: SECRET, event: event({ type: "bad type" }), timestamp: NOW })).toThrow();
  });

  it("is a different body from every channel event type (a channel adapter cannot mistake one for the other)", () => {
    expect(CHANNEL_EVENT_TYPES as readonly string[]).not.toContain("task.plan_ready");
    const body = JSON.parse(signOutboundEvent({ secret: SECRET, event: event(), timestamp: NOW }).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("conversation");
    expect(body).not.toHaveProperty("channel");
  });
});

describe("publishing to the registered adapters", () => {
  const recorder = (options: { accepts?: (type: string) => boolean; fail?: Error } = {}): OutboundEventsAdapter & { received: OutboundEvent[] } => {
    const received: OutboundEvent[] = [];
    return {
      received,
      ...(options.accepts === undefined ? {} : { accepts: options.accepts }),
      async deliver(delivered) {
        if (options.fail !== undefined) throw options.fail;
        received.push(delivered);
      },
    };
  };

  it("delivers to every adapter that wants the type, skips the others, and reports one that fails without stopping the rest", async () => {
    const registry = createAdapterRegistry();
    const all = recorder();
    const merged = recorder({ accepts: (type) => type === "task.merged" });
    const broken = recorder({ fail: new TypeError("https://hook.example.test/secret-path") });
    registry.register("outbound-events", "all", all);
    registry.register("outbound-events", "merged-only", merged);
    registry.register("outbound-events", "broken", broken);
    const result = await publishOutboundEvent(registry, event());
    expect(result.delivered).toEqual(["all"]);
    expect(result.skipped).toEqual(["merged-only"]);
    expect(result.failed).toEqual([{ adapter: "broken", error: "delivery_failed" }]);
    expect(JSON.stringify(result.failed)).not.toContain("secret-path");
    expect(all.received).toHaveLength(1);
    expect(merged.received).toHaveLength(0);
  });

  it("gives an adapter its own copy, and the same id on a retry", async () => {
    const registry = createAdapterRegistry();
    const mutating: OutboundEventsAdapter & { seen: string[] } = { seen: [], async deliver(delivered) { this.seen.push(delivered.id); (delivered.data as Record<string, unknown>).tampered = true; } };
    const watcher = recorder();
    registry.register("outbound-events", "a-mutating", mutating);
    registry.register("outbound-events", "b-watcher", watcher);
    const input = event();
    await publishOutboundEvent(registry, input);
    await publishOutboundEvent(registry, input);
    expect(watcher.received.map((delivered) => delivered.id)).toEqual([input.id, input.id]);
    expect(watcher.received[0]?.data).not.toHaveProperty("tampered");
  });

  it("throws for an event that is not valid (the caller's bug), and does nothing for no adapter", async () => {
    const registry = createAdapterRegistry();
    await expect(publishOutboundEvent(registry, event({ type: "bad type" }))).rejects.toThrow();
    const result = await publishOutboundEvent(registry, event());
    expect(result.delivered).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("an adapter whose accepts throws is a failure, not a skip, and its deliver is never called", async () => {
    const registry = createAdapterRegistry();
    registry.register("outbound-events", "odd", { accepts: () => { throw new Error("x"); }, deliver: async () => { throw new Error("never called"); } });
    const result = await publishOutboundEvent(registry, event());
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([{ adapter: "odd", error: "accepts_failed" }]);
  });

  it("an adapter that hangs is cut off at the time limit and reported as a timeout, and the others still deliver", async () => {
    const registry = createAdapterRegistry();
    const fine = recorder();
    registry.register("outbound-events", "a-hangs", { deliver: () => new Promise<void>(() => undefined) });
    registry.register("outbound-events", "b-fine", fine);
    const started = Date.now();
    const result = await publishOutboundEvent(registry, event(), { timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.failed).toEqual([{ adapter: "a-hangs", error: "timeout" }]);
    expect(result.delivered).toEqual(["b-fine"]);
  });

  it("reports a fixed kind, never the adapter's own error name or text, even when the adapter names its error after a secret", async () => {
    const registry = createAdapterRegistry();
    const sneaky = Object.assign(new Error("token=abc"), { name: "https://user:pw@hook.example.test/secret" });
    registry.register("outbound-events", "sneaky", { deliver: async () => { throw sneaky; } });
    registry.register("outbound-events", "sync-throw", { deliver: () => { throw sneaky; } });
    const result = await publishOutboundEvent(registry, event());
    expect(result.failed).toEqual([{ adapter: "sneaky", error: "delivery_failed" }, { adapter: "sync-throw", error: "delivery_failed" }]);
    expect(JSON.stringify(result.failed)).not.toContain("secret");
  });

  it("loads from a config entry like any other point", async () => {
    const received: OutboundEvent[] = [];
    const module: PluginModule<"outbound-events"> = { point: "outbound-events", name: "memory", create: () => ({ deliver: async (delivered) => { received.push(delivered); } }) };
    const importer: ModuleImporter = async (specifier) => {
      if (specifier !== "./memory-events.js") throw new Error("no such module");
      return { plugin: module };
    };
    const registry = createAdapterRegistry();
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "outbound-events", name: "memory", module: "./memory-events.js" }] }), { registry, importModule: importer });
    await publishOutboundEvent(registry, event());
    expect(received).toHaveLength(1);
  });
});
