// Lane L6b: notifications, channel only. A session that moves into a state someone must act on is queued for them; the sweep batches what is pending into one event per target and sends it through the
// channel adapters the registry holds. The adapters here are fakes; no provider is named.
 
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, agentSessionKey, type ConversationRef, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FAKE_CHANNEL_CAPABILITIES, FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createTaskSessionItems, developerIdOf, refreshSessionSummary, taskSessionId, type SessionChange, type SessionTaskFacts, type SummaryDependencies } from "../../packages/broker/src/core/sessions/index.js";
import {
  ATTENTION_TARGET_TRIES_MAX, attentionText, batchEventId, deliverAttention, queueAttention, writeNotifyPrefs, PENDING_PK,
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
  const move = async (facts: Partial<SessionTaskFacts>, onChange?: SummaryDependencies["onChange"]) => { state.facts = { ...state.facts, ...facts }; clock.ms += 1_000; return refreshSessionSummary(onChange === undefined ? deps : { ...deps, onChange }, ORG, SESSION); };
  const deliver = (overrides: Record<string, unknown> = {}) => deliverAttention({ store, registry, now: () => clock.ms, log: () => undefined, link: (session) => `https://example.test/sessions/${session.sessionId}`, ...overrides });
  const prefs = (targets: unknown[], muted = false) => writeNotifyPrefs({ store, now: () => new Date(clock.ms) }, ORG, OWNER_ID, { targets, muted });
  return { store, state, deps, registry, adapter, pending, move, deliver, prefs, logs };
}

const target = (conversation = CONVERSATION) => ({ channel: conversation.channel, conversation });

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
    // A real committed change into Needs you, on a session whose previous summary has a `display`, so queueAttention reaches the store write.
    const live = await world();
    await live.move({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" } });
    await live.move({ workflow: { stage: "IMPLEMENT", state: "RUNNING" } });
    const changes: SessionChange[] = [];
    await live.move({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" } }, [async (change) => { changes.push(change); }]);
    expect(changes).toHaveLength(1);
    expect((changes[0]!.previous as { display?: unknown }).display).toBeDefined();
    const logs: Array<Record<string, unknown>> = [];
    let writes = 0;
    const broken = await queueAttention({ store: { put: async () => { writes += 1; throw new Error("down"); }, query: async () => ({ items: [] }) }, log: (entry) => logs.push(entry) }, changes[0]!);
    expect(writes).toBeGreaterThan(0);
    expect(broken).toBe(0);
    expect(logs).toEqual([expect.objectContaining({ event: "attention.queue_failed" })]);
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

  it("sends to no chat when the host cannot say whose tenant a target is (companyOf throws)", async () => {
    const w = await needsYou();
    await w.prefs([target()]);
    expect(await w.deliver({ companyOf: () => { throw new Error("tenant map down"); } })).toMatchObject({ sent: 0, unreachable: 1 });
    expect(w.adapter.delivered).toEqual([]);
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
});

describe("followers, the conversation a task was started from, and the footer", () => {
  const FOLLOWER = "f".repeat(64);
  const follow = (store: MemoryDocumentStore) => store.put({ item: { ...agentSessionKey(ORG, SESSION, `FOLLOWER#${FOLLOWER}`), entityType: "AGENT_SESSION_FOLLOWER", developerId: FOLLOWER } });

  it("tells the followers of a session when it fails or ends, and not when it only waits", async () => {
    const waiting = await world();
    await follow(waiting.store);
    await waiting.move({});
    await waiting.move({ workflow: { stage: "IMPLEMENT", state: "RUNNING" } });
    await waiting.move({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" } });
    expect((await waiting.pending()).map((row) => row["developerId"])).toEqual([OWNER_ID]);
    const failed = await world();
    await follow(failed.store);
    await failed.move({});
    await failed.move({ workflow: undefined, runStatus: "FAILED", failureCategory: "timed_out" });
    expect((await failed.pending()).map((row) => row["developerId"]).sort()).toEqual([FOLLOWER, OWNER_ID].sort());
    // The follower is messaged only where they chose, and only when they may still read the session.
    await writeNotifyPrefs({ store: failed.store, now: () => new Date(clock.ms) }, ORG, FOLLOWER, { targets: [target()] });
    await failed.prefs([target(OTHER_CONVERSATION)]).catch(() => undefined);
    const outcome = await failed.deliver({ access: async (_org: OrgId, person: string) => (person === FOLLOWER ? { owner: false } : undefined) });
    expect(outcome).toMatchObject({ people: 1, sent: 1 });
    expect(failed.adapter.delivered).toHaveLength(1);
  });

  it("tells the conversation a task was started from, even where the channel may not message first, and never past a mute", async () => {
    const w = await needsYou();
    const quiet = new FakeChannelAdapter({ ...FAKE_CHANNEL_CAPABILITIES, proactive: false });
    w.registry.register("channel", "otherchat", quiet);
    const started: ConversationRef = { channel: "otherchat", tenant: "team1", space: "room1", thread: "main" };
    const thread = async (_org: OrgId, sessionId: string) => (sessionId === SESSION ? { conversation: started, personId: OWNER_ID } : undefined);
    // No place chosen at all: the conversation of the start is where they are told.
    const outcome = await w.deliver({ thread });
    expect(outcome).toMatchObject({ people: 1, sent: 1, unreachable: 0 });
    expect(quiet.delivered).toHaveLength(1);
    expect(quiet.delivered[0]).toMatchObject({ conversation: started, channel: "otherchat" });
    expect(await w.pending()).toHaveLength(0);
    // A person who muted notices is told nowhere, the conversation of a start included.
    const muted = await needsYou();
    const quiet2 = new FakeChannelAdapter({ ...FAKE_CHANNEL_CAPABILITIES, proactive: false });
    muted.registry.register("channel", "otherchat", quiet2);
    await muted.prefs([], true);
    await muted.deliver({ thread });
    expect(quiet2.delivered).toEqual([]);
    // A conversation another person started is not this person's.
    const other = await needsYou();
    const quiet3 = new FakeChannelAdapter();
    other.registry.register("channel", "otherchat", quiet3);
    await other.deliver({ thread: async () => ({ conversation: started, personId: "e".repeat(64) }) });
    expect(quiet3.delivered).toEqual([]);
  });

  it("leaves the finished-task notice out of the start thread while the channel milestones tell it, and still tells the places the person chose and the other notices", async () => {
    const started: ConversationRef = { channel: "otherchat", tenant: "team1", space: "room1", thread: "main" };
    const thread = async (_org: OrgId, sessionId: string) => (sessionId === SESSION ? { conversation: started, personId: OWNER_ID } : undefined);
    const finished = async () => {
      const w = await world();
      const quiet = new FakeChannelAdapter();
      w.registry.register("channel", "otherchat", quiet);
      await w.move({});
      await w.move({ workflow: { stage: "MERGED", state: "COMPLETE" }, step: "Merged" });
      await w.prefs([target()]);
      return { w, quiet };
    };
    const milestones = await finished();
    await milestones.w.deliver({ thread, doneToldInThread: () => true });
    expect(milestones.quiet.delivered).toEqual([]);
    expect(milestones.w.adapter.delivered).toHaveLength(1);
    expect(await milestones.w.pending()).toHaveLength(0);
    // Without them (the default), the thread is told as before.
    const before = await finished();
    await before.w.deliver({ thread });
    expect(before.quiet.delivered).toHaveLength(1);
    expect(before.quiet.delivered[0]).toMatchObject({ type: "done" });
    // A needs-you notice still goes to the thread.
    const waiting = await needsYou();
    const quiet = new FakeChannelAdapter();
    waiting.registry.register("channel", "otherchat", quiet);
    await waiting.deliver({ thread, doneToldInThread: () => true });
    expect(quiet.delivered).toHaveLength(1);
  });

  it("skips the thread's reminder for a plan that already got its card, and only for that: the places the person chose and every other notice still get theirs", async () => {
    const started: ConversationRef = { channel: "otherchat", tenant: "team1", space: "room1", thread: "main" };
    const thread = async (_org: OrgId, sessionId: string) => (sessionId === SESSION ? { conversation: started, personId: OWNER_ID } : undefined);
    const setup = async (move: typeof needsYou) => {
      const w = await move();
      const quiet = new FakeChannelAdapter();
      w.registry.register("channel", "otherchat", quiet);
      return { w, quiet };
    };
    // A carded plan: the thread is not told again; the chosen place is.
    const carded = await setup(needsYou);
    await carded.w.prefs([target()]);
    const asked: string[] = [];
    await carded.w.deliver({ thread, planCarded: async (session: { sessionId: string }) => { asked.push(session.sessionId); return true; } });
    expect(asked).toEqual([SESSION]);
    expect(carded.quiet.delivered).toEqual([]);
    expect(carded.w.adapter.delivered).toHaveLength(1);
    expect(await carded.w.pending()).toHaveLength(0);
    // A plan with no card, and a check that fails: the thread is told.
    for (const planCarded of [async () => false, async () => { throw new Error("store down"); }]) {
      const open = await setup(needsYou);
      await open.w.prefs([target()]);
      await open.w.deliver({ thread, planCarded });
      expect(open.quiet.delivered).toHaveLength(1);
      expect(open.w.adapter.delivered).toHaveLength(1);
    }
    // Not asked, and not skipped, for a notice that is not a wait: failed and done still go to the thread.
    const failed = await setup(async () => {
      const w = await world();
      await w.move({});
      await w.move({ workflow: undefined, runStatus: "FAILED", failureCategory: "timed_out" });
      return w;
    });
    let questions = 0;
    await failed.w.deliver({ thread, planCarded: async () => { questions += 1; return true; } });
    expect(questions).toBe(0);
    expect(failed.quiet.delivered).toHaveLength(1);
  });

  it("L4-U5: skips the thread's reminder for a task whose setup pause was already told there (one message for the requester), and only for that", async () => {
    const started: ConversationRef = { channel: "otherchat", tenant: "team1", space: "room1", thread: "main" };
    const thread = async (_org: OrgId, sessionId: string) => (sessionId === SESSION ? { conversation: started, personId: OWNER_ID } : undefined);
    const setup = async () => { const w = await needsYou(); const quiet = new FakeChannelAdapter(); w.registry.register("channel", "otherchat", quiet); await w.prefs([target()]); return { w, quiet }; };
    const told = await setup();
    const asked: string[] = [];
    await told.w.deliver({ thread, setupPausedTold: async (session: { sessionId: string }) => { asked.push(session.sessionId); return true; } });
    expect(asked).toEqual([SESSION]);
    expect(told.quiet.delivered).toEqual([]);
    expect(told.w.adapter.delivered).toHaveLength(1);
    for (const setupPausedTold of [async () => false, async () => { throw new Error("store down"); }]) {
      const open = await setup();
      await open.w.deliver({ thread, setupPausedTold });
      expect(open.quiet.delivered).toHaveLength(1);
    }
  });

  it("applies the reminder skip to needs-you only: a paused, ready, failed or done notice still goes to the thread even when the plan is carded", async () => {
    const started: ConversationRef = { channel: "otherchat", tenant: "team1", space: "room1", thread: "main" };
    const thread = async (_org: OrgId, sessionId: string) => (sessionId === SESSION ? { conversation: started, personId: OWNER_ID } : undefined);
    const moves: Record<string, Partial<SessionTaskFacts>> = {
      paused: { workflow: undefined, display: { state: "paused_budget", reason: "it reached its spending limit" } },
      ready: { workflow: undefined, display: { state: "ready_to_merge" } },
      failed: { workflow: undefined, runStatus: "FAILED", failureCategory: "timed_out" },
      done: { workflow: { stage: "MERGED", state: "COMPLETE" }, step: "Merged" },
    };
    for (const [name, move] of Object.entries(moves)) {
      const w = await world();
      const quiet = new FakeChannelAdapter();
      w.registry.register("channel", "otherchat", quiet);
      await w.move({});
      await w.move(move);
      expect((await w.pending()).map((row) => row["kind"]), name).toEqual([name === "done" ? "done" : name]);
      let asked = 0;
      await w.deliver({ thread, planCarded: async () => { asked += 1; return true; } });
      expect(quiet.delivered, name).toHaveLength(1);
      expect(asked, name).toBe(0);
    }
  });

  it("adds the footer after the list and keeps it whole when the text is cut", async () => {
    const w = await needsYou();
    await w.prefs([target()]);
    await w.deliver({ footer: "Open it with `rovara open`." });
    expect((w.adapter.delivered[0]!.data as { text: string }).text.endsWith("\nOpen it with `rovara open`.")).toBe(true);
    const line = { title: "x".repeat(300), status: "Needs you", kind: "needs_you" as const };
    const cut = attentionText([line], 0, 200, "Open it with `rovara open`.");
    expect([...cut].length).toBeLessThanOrEqual(200);
    expect(cut.endsWith("Open it with `rovara open`.")).toBe(true);
  });

  it("logs how many places were left out when a person has more than the cap, and still tells the first ones", async () => {
    const w = await needsYou();
    await w.prefs([target(), target(OTHER_CONVERSATION)]);
    w.registry.register("channel", "otherchat", new FakeChannelAdapter());
    const logs: Array<Record<string, unknown>> = [];
    await w.deliver({ maxTargets: 1, log: (entry: Record<string, unknown>) => logs.push(entry) });
    expect(logs).toContainEqual({ event: "attention.thread_targets_truncated", dropped: 1 });
    expect(w.adapter.delivered).toHaveLength(1);
  });
});
