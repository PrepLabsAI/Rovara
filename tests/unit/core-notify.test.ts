// Lane L6b: notifications, channel only. A session that moves into a state someone must act on is queued for them; the sweep batches what is pending into one event per target and sends it through the
// channel adapters the registry holds. The adapters here are fakes; no provider is named.
 
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, NOTIFY_BATCH_MINUTES, type ChannelEvent, type ConversationRef, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FAKE_CHANNEL_CAPABILITIES, FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createTaskSessionItems, developerIdOf, refreshSessionSummary, taskSessionId, type SessionTaskFacts, type SummaryDependencies } from "../../packages/broker/src/core/sessions/index.js";
import {
  ATTENTION_RETRY_BASE_MS, ATTENTION_TARGET_TRIES_MAX, attentionKindOf, attentionText, batchEventId, deliverAttention, queueAttention, readNotifyPrefs, writeNotifyPrefs, PENDING_PK,
} from "../../packages/broker/src/core/notify/index.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OWNER = localOwnerPrincipal();
const OWNER_ID = developerIdOf(OWNER);
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const SESSION = taskSessionId(TASK);
const T0 = "2026-11-09T10:00:00.000Z";
const clock = { ms: Date.parse("2026-11-09T10:05:00.000Z") };
const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };
const OTHER_CONVERSATION: ConversationRef = { channel: "otherchat", tenant: "team1", space: "room1", thread: "main" };

async function world() {
  const store = new MemoryDocumentStore();
  const state = { facts: { companyId: ORG, taskId: TASK, project: "web", ownerDeveloperId: OWNER_ID, runStatus: "RUNNING", workflow: { stage: "IMPLEMENT", state: "RUNNING" }, step: "Coding", updatedAt: T0 } as SessionTaskFacts };
  const logs: Array<Record<string, unknown>> = [];
  const deps: SummaryDependencies = {
    store, facts: { read: async () => state.facts }, cost: { costUsd: async () => 0 }, now: () => new Date(clock.ms), log: () => undefined,
    onChange: [async (change) => { await queueAttention({ store, now: () => new Date(clock.ms), log: (entry) => logs.push(entry) }, change); }],
  };
  await store.transact(createTaskSessionItems({ orgId: ORG, sessionId: SESSION, taskId: TASK, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Add retry", owner: OWNER, origin: "app", payer: { kind: "member", developerId: OWNER_ID } as never, now: T0 }));
  const registry = createAdapterRegistry();
  const adapter = new FakeChannelAdapter();
  registry.register("channel", "examplechat", adapter);
  const pending = async () => (await store.query({ pk: PENDING_PK })).items;
  const move = async (facts: Partial<SessionTaskFacts>) => { state.facts = { ...state.facts, ...facts }; clock.ms += 1_000; return refreshSessionSummary(deps, ORG, SESSION); };
  const deliver = (overrides: Record<string, unknown> = {}) => deliverAttention({ store, registry, now: () => clock.ms, log: () => undefined, link: (session) => `https://example.test/sessions/${session.sessionId}`, ...overrides });
  const prefs = (targets: unknown[], muted = false) => writeNotifyPrefs({ store, now: () => new Date(clock.ms) }, ORG, OWNER_ID, { targets, muted });
  return { store, state, deps, registry, adapter, pending, move, deliver, prefs, logs };
}

const target = (conversation = CONVERSATION) => ({ channel: conversation.channel, conversation });

describe("what a status calls for", () => {
  it("names the kind for the states a person acts on or is told have ended, and nothing for the rest", () => {
    const summary = (status: string, extra: Record<string, unknown> = {}) => attentionKindOf({ status, ...extra } as never);
    expect(summary("needs_person")).toBe("needs_you");
    expect(summary("paused")).toBe("paused");
    expect(summary("failed")).toBe("failed");
    expect(summary("waiting", { lastRunFailed: true })).toBe("failed");
    expect(summary("running")).toBeUndefined();
    expect(summary("starting")).toBeUndefined();
    expect(summary("succeeded")).toBe("done");
  });
});

describe("queueing", () => {
  it("a session that moves into Needs you is queued for its owner once, and a repeat of the same state is not", async () => {
    const w = await world();
    // The summary written at creation has no status-model words, so the first refresh is not announced (nobody is told about work already waiting at upgrade).
    await w.move({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" } });
    expect(await w.pending()).toHaveLength(0);
    await w.move({ workflow: { stage: "IMPLEMENT", state: "RUNNING" } });
    expect(await w.pending()).toHaveLength(0);
    await w.move({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" } });
    const rows = await w.pending();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ developerId: OWNER_ID, sessionId: SESSION, kind: "needs_you" });
    // The same state with another step line is not a change of state.
    await w.move({ step: "Waiting for approval" });
    expect(await w.pending()).toHaveLength(1);
  });

  it("an ended session is told as done or failed only, and a queue failure never fails the refresh", async () => {
    const w = await world();
    await w.move({});
    await w.move({ workflow: { stage: "MERGED", state: "COMPLETE" }, step: "Merged" });
    expect((await w.pending()).map((row) => row["kind"])).toEqual(["done"]);
    const broken = await queueAttention({ store: { put: async () => { throw new Error("down"); } }, log: () => undefined }, { ...({} as never), session: { subject: { kind: "task" } }, summary: { status: "needs_person", display: undefined }, previous: {} } as never);
    expect(broken).toBe(0);
  });
});

describe("preferences", () => {
  it("keeps where a person is told, refuses a conversation on another channel, and leaves the hosted channel choice alone", async () => {
    const w = await world();
    await w.store.put({ item: { pk: `NOTIFY_PREFS#${ORG}`, sk: `DEV#${OWNER_ID}`, orgId: ORG, channel: "both" } });
    expect(await w.prefs([target(), target(), target(OTHER_CONVERSATION)])).toMatchObject({ targets: [expect.anything(), expect.anything()], muted: false });
    expect((await readNotifyPrefs(w.store, ORG, OWNER_ID)).targets).toHaveLength(2);
    expect((await w.store.get({ pk: `NOTIFY_PREFS#${ORG}`, sk: `DEV#${OWNER_ID}` }))!["channel"]).toBe("both");
    await expect(w.prefs([{ channel: "examplechat", conversation: OTHER_CONVERSATION }])).rejects.toThrow();
    await expect(w.prefs(Array.from({ length: 6 }, (_, index) => target({ ...CONVERSATION, thread: `t${String(index)}` })))).rejects.toThrow();
    expect(await readNotifyPrefs(w.store, ORG, "e".repeat(64))).toEqual({ targets: [], muted: false });
  });
});

async function needsYou() {
  const w = await world();
  await w.move({});
  await w.move({ workflow: { stage: "IMPLEMENT", state: "RUNNING" } });
  await w.move({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" } });
  return w;
}

describe("delivering", () => {
  it("sends one event to the person's target with the task's title, its status words and the link, and removes the row", async () => {
    const w = await needsYou();
    await w.prefs([target()]);
    const outcome = await w.deliver();
    expect(outcome).toMatchObject({ people: 1, sent: 1, dropped: 0 });
    expect(w.adapter.delivered).toHaveLength(1);
    const event = w.adapter.delivered[0]!;
    expect(event).toMatchObject({ version: 1, type: "progress", channel: "examplechat", conversation: CONVERSATION });
    const text = (event.data as { text: string }).text;
    expect(text).toContain("Add retry");
    expect(text).toContain("Needs you");
    expect(text).toContain(`https://example.test/sessions/${SESSION}`);
    expect(await w.pending()).toHaveLength(0);
  });

  it("a person gets at most one message per batch window; what arrives in between waits for the next", async () => {
    const w = await needsYou();
    await w.prefs([target()]);
    await w.deliver();
    await w.move({ workflow: { stage: "IMPLEMENT", state: "RUNNING" } });
    await w.move({ workflow: { stage: "IMPLEMENT", state: "BLOCKED", blockReason: "tests failed" } });
    expect((await w.pending()).length).toBe(1);
    expect(await w.deliver()).toMatchObject({ people: 0, sent: 0 });
    expect(w.adapter.delivered).toHaveLength(1);
    clock.ms += NOTIFY_BATCH_MINUTES * 60_000 + 1;
    await w.deliver();
    expect(w.adapter.delivered).toHaveLength(2);
  });

  it("a row whose session moved on, or that the person may no longer read, is dropped without a word", async () => {
    const w = await needsYou();
    await w.prefs([target()]);
    await w.move({ workflow: { stage: "IMPLEMENT", state: "RUNNING" } });
    expect(await w.deliver()).toMatchObject({ sent: 0, dropped: 1 });
    expect(w.adapter.delivered).toHaveLength(0);
    const again = await needsYou();
    await again.prefs([target()]);
    expect(await again.deliver({ access: async () => undefined })).toMatchObject({ sent: 0, dropped: 1 });
  });

  it("a muted person, or one with nowhere to be told, is not messaged and the rows go", async () => {
    const w = await needsYou();
    expect(await w.deliver()).toMatchObject({ sent: 0 });
    expect(await w.pending()).toHaveLength(0);
    const muted = await needsYou();
    await muted.prefs([target()], true);
    expect(await muted.deliver()).toMatchObject({ sent: 0 });
    expect(muted.adapter.delivered).toHaveLength(0);
  });

  it("a failing target is retried after a growing wait with the same event, and gives up after its tries; another target is not held back", async () => {
    const w = await needsYou();
    const flaky = new FakeChannelAdapter();
    let fail = true;
    const original = flaky.deliver.bind(flaky);
    flaky.deliver = async (event) => { if (fail) throw new Error("down"); await original(event); };
    w.registry.register("channel", "otherchat", flaky);
    await w.prefs([target(), target(OTHER_CONVERSATION)]);
    const first = await w.deliver();
    expect(first).toMatchObject({ sent: 1, failed: 1 });
    expect(w.adapter.delivered).toHaveLength(1);
    expect((await w.pending())).toHaveLength(1);
    // Too soon to try the failing target again, and the working one has the row already.
    expect(await w.deliver()).toMatchObject({ sent: 0, failed: 0 });
    clock.ms += ATTENTION_RETRY_BASE_MS + NOTIFY_BATCH_MINUTES * 60_000;
    fail = false;
    expect(await w.deliver()).toMatchObject({ sent: 1 });
    expect(flaky.delivered).toHaveLength(1);
    expect(w.adapter.delivered).toHaveLength(1);
    expect(await w.pending()).toHaveLength(0);
  });

  it("gives up on a target that keeps failing", async () => {
    const w = await needsYou();
    const dead = new FakeChannelAdapter();
    dead.deliver = async () => { throw new Error("down"); };
    w.registry.register("channel", "otherchat", dead);
    await w.prefs([target(OTHER_CONVERSATION)]);
    let gaveUp = 0;
    for (let attempt = 0; attempt < ATTENTION_TARGET_TRIES_MAX + 2; attempt += 1) {
      clock.ms += 3 * 60 * 60_000;
      gaveUp += (await w.deliver()).gaveUp;
    }
    expect(gaveUp).toBe(1);
    expect(await w.pending()).toHaveLength(0);
  });

  it("a channel nobody serves, or one that cannot message first, is counted as unreachable and not retried", async () => {
    const w = await needsYou();
    w.registry.register("channel", "otherchat", new FakeChannelAdapter({ ...FAKE_CHANNEL_CAPABILITIES, proactive: false }));
    await w.prefs([target(OTHER_CONVERSATION), target({ ...CONVERSATION, channel: "missingchat" })]);
    expect(await w.deliver()).toMatchObject({ sent: 0, unreachable: 2 });
    expect(await w.pending()).toHaveLength(0);
  });

  it("the event id belongs to the batch: the same rows to the same target give the same id", () => {
    const rows = [{ sk: "a", at: "t1" }, { sk: "b", at: "t2" }];
    expect(batchEventId("o", "p", "x", rows)).toBe(batchEventId("o", "p", "x", [...rows].reverse()));
    expect(batchEventId("o", "p", "x", rows)).not.toBe(batchEventId("o", "p", "y", rows));
    expect(batchEventId("o", "p", "x", rows)).not.toBe(batchEventId("o", "p", "x", rows.slice(1)));
    expect(batchEventId("o", "p", "x", rows)).toMatch(/^evt_[A-Za-z0-9_-]{32}$/u);
  });

  it("the text is cut to the channel's limit and counts the tasks it does not list", () => {
    const line = { title: "T".repeat(90), status: "Needs you", kind: "needs_you" as const };
    const text = attentionText(Array.from({ length: 10 }, () => line), 4, 600);
    expect([...text].length).toBeLessThanOrEqual(600);
    expect(attentionText([line], 0, 4000)).toContain("A task needs your attention");
    expect(attentionText([line, line], 3, 4000)).toContain("and 3 more");
  });

  it("a failed task is sent as an error event, and a finished one as done", async () => {
    const w = await world();
    await w.move({});
    await w.prefs([target()]);
    await w.move({ workflow: undefined, runStatus: "FAILED", failureCategory: "timed_out" });
    await w.deliver();
    const event: ChannelEvent = w.adapter.delivered.at(-1)!;
    expect(event.type).toBe("error");
    expect(event.data).toMatchObject({ code: "task_failed" });
    const finished = await world();
    await finished.move({});
    await finished.prefs([target()]);
    await finished.move({ workflow: { stage: "MERGED", state: "COMPLETE" }, step: "Merged" });
    await finished.deliver();
    expect(finished.adapter.delivered.at(-1)!.type).toBe("done");
  });
});
