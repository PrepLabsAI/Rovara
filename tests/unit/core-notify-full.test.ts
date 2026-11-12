// Lane P4: full notifications in Code's core. A person's settings (where: chat, email or both; quiet hours; a daily digest; their time zone) live on the hosted product's preference row; email goes out only
// through the `email` point when it says it can send (Code's default cannot, decision 101), otherwise the chats carry it; quiet hours and a digest hold what is not urgent and send it in one batch; the
// person's pages hear an ids-only realtime hint. Adapted from the hosted product's attention tests (who is told, how and how often, no leakage, review fixes I1 and N2) plus new cases. Fakes only.

import { describe, expect, it } from "vitest";
import { EmailError, IMPLICIT_COMPANY_ID, NOTIFY_BATCH_MINUTES, effectiveNotify, isRealtimeNotice, type ConversationRef, type EmailSender, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { createFakeEmailSender, createUnavailableEmailSender } from "../../packages/broker/src/ports/email.js";
import { createInProcessRealtime } from "../../packages/broker/src/ports/realtime.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createTaskSessionItems, developerIdOf, refreshSessionSummary, taskSessionId, type SessionTaskFacts, type SummaryDependencies } from "../../packages/broker/src/core/sessions/index.js";
import {
  ATTENTION_RETRY_BASE_MS, ATTENTION_TARGET_TRIES_MAX, EMAIL_TARGET, PENDING_PK, attentionEmail, attentionNotice, dayBefore, deliverAttention, digestSlotDay, holdOf, inQuietHours, localClock, prefsKey, queueAttention, readNotifyPrefs,
  writeNotifyPrefs,
} from "../../packages/broker/src/core/notify/index.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OWNER = localOwnerPrincipal();
const OWNER_ID = developerIdOf(OWNER);
const TASKS = ["8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", "1f0e2d3c-4b5a-4697-8877-665544332211"];
const T0 = "2026-11-09T10:00:00.000Z";
const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };
const ADDRESS = "owner@example.com";
const SECRET_STEP = "sk-notes-should-never-leave";

interface Task { facts: SessionTaskFacts; sessionId: string }

/** A store with two task sessions, a chat adapter, an email sender and a clock. `move(index, facts)` refreshes one session the way the sweep does (queueing what it calls for). */
async function world(options: { email?: EmailSender | "none"; startMs?: number } = {}) {
  const clock = { ms: options.startMs ?? Date.parse("2026-11-09T10:05:00.000Z") };
  const store = new MemoryDocumentStore();
  const realtime = createInProcessRealtime();
  const tasks: Task[] = TASKS.map((taskId) => ({ sessionId: taskSessionId(taskId), facts: { companyId: ORG, taskId, project: "web", ownerDeveloperId: OWNER_ID, runStatus: "RUNNING", workflow: { stage: "IMPLEMENT", state: "RUNNING" }, step: SECRET_STEP, updatedAt: T0 } }));
  const deps = (task: Task): SummaryDependencies => ({
    store, facts: { read: async () => task.facts }, cost: { costUsd: async () => 0 }, now: () => new Date(clock.ms), log: () => undefined,
    onChange: [async (change) => { await queueAttention({ store, now: () => new Date(clock.ms), log: () => undefined, realtime }, change); }],
  });
  for (const [index, task] of tasks.entries()) {
    await store.transact(createTaskSessionItems({ orgId: ORG, sessionId: task.sessionId, taskId: task.facts.taskId, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: index === 0 ? "Add retry" : "Fix login", owner: OWNER, origin: "app", payer: { kind: "member", developerId: OWNER_ID } as never, now: T0 }));
  }
  const registry = createAdapterRegistry();
  const chat = new FakeChannelAdapter();
  registry.register("channel", "examplechat", chat);
  const fake = createFakeEmailSender({ capabilities: { html: false } });
  if (options.email !== "none") registry.register("email", "test", options.email ?? fake);
  const move = async (index: number, facts: Partial<SessionTaskFacts>) => { const task = tasks[index]!; task.facts = { ...task.facts, ...facts }; clock.ms += 1_000; await refreshSessionSummary(deps(task), ORG, task.sessionId); };
  // A session's first refresh after creation is never announced; this one makes the next change into Needs you a real change.
  const needsYou = async (index: number) => { await move(index, {}); await move(index, { workflow: { stage: "IMPLEMENT", state: "RUNNING" } }); await move(index, { workflow: { stage: "PLAN_REVIEW", state: "WAITING" } }); };
  const pending = async () => (await store.query({ pk: PENDING_PK })).items;
  const deliver = (overrides: Record<string, unknown> = {}) => deliverAttention({
    store, registry, now: () => clock.ms, log: () => undefined, link: (session) => `https://rovara.example/app/sessions/${session.sessionId}`,
    address: async (_org: OrgId, person: string) => (person === OWNER_ID ? ADDRESS : undefined),
    emailLinks: { settings: "https://rovara.example/app/account#notifications", unsubscribe: "https://rovara.example/app/account?notify=unsubscribe#notifications", home: "https://rovara.example/app" }, ...overrides,
  });
  const prefs = (body: Record<string, unknown>) => writeNotifyPrefs({ store, now: () => new Date(clock.ms) }, ORG, OWNER_ID, body);
  return { clock, store, realtime, tasks, registry, chat, fake, move, needsYou, pending, deliver, prefs };
}

const chatTarget = { channel: CONVERSATION.channel, conversation: CONVERSATION };
const textOf = (event: { data: unknown }): string => (event.data as { text: string }).text;

describe("settings", () => {
  it("writes only the fields of a change, clears with null, reads the hosted product's row and its words, and refuses what makes no sense", async () => {
    const w = await world();
    // A row the hosted product wrote (its channel choice and the unsubscribe) is read as it is.
    await w.store.put({ item: { ...prefsKey(ORG, OWNER_ID), entityType: "NOTIFY_PREFS", orgId: ORG, developerId: OWNER_ID, channel: "both", emailUnsubscribed: true } });
    expect(await readNotifyPrefs(w.store, ORG, OWNER_ID)).toEqual({ targets: [], muted: false, channel: "both", emailUnsubscribed: true });
    // A change of the quiet hours leaves the channel, the unsubscribe and the targets alone.
    await w.prefs({ targets: [chatTarget] });
    const after = await w.prefs({ quietHours: { start: "22:00", end: "07:00" }, timeZone: "Europe/Berlin", digestAt: "09:00" });
    expect(after).toEqual({ targets: [chatTarget], muted: false, channel: "both", emailUnsubscribed: true, quietHours: { start: "22:00", end: "07:00" }, timeZone: "Europe/Berlin", digestAt: "09:00" });
    // Choosing email again turns email back on after an unsubscribe (the hosted account page's rule); null clears a setting.
    expect(await w.prefs({ channel: "email" })).toMatchObject({ channel: "email", emailUnsubscribed: false });
    expect(await w.prefs({ quietHours: null, digestAt: null, channel: null })).toEqual({ targets: [chatTarget], muted: false, emailUnsubscribed: false, timeZone: "Europe/Berlin" });
    await expect(w.prefs({ quietHours: { start: "22:00", end: "22:00" } })).rejects.toThrow();
    await expect(w.prefs({ quietHours: { start: "25:00", end: "07:00" } })).rejects.toThrow();
    await expect(w.prefs({ timeZone: "Mars/Olympus" })).rejects.toThrow();
    await expect(w.prefs({ channel: "pigeon" })).rejects.toThrow();
    await expect(w.prefs({ surprise: true })).rejects.toThrow();
    // A stored field that does not parse reads as its default, never as an error.
    await w.store.put({ item: { ...prefsKey(ORG, OWNER_ID), orgId: ORG, quietHours: { start: "x" }, timeZone: "Nowhere/None", digestAt: 9, channel: "fax" } });
    expect(await readNotifyPrefs(w.store, ORG, OWNER_ID)).toEqual({ targets: [], muted: false, emailUnsubscribed: false });
    // Another company's row is not this person's.
    await w.store.put({ item: { ...prefsKey(ORG, OWNER_ID), orgId: "other-company", channel: "email" } });
    expect((await readNotifyPrefs(w.store, ORG, OWNER_ID)).channel).toBeUndefined();
  });
});

describe("where: chat, email or both", () => {
  it("emails a person who has no chat (the default), with only the title, the status sentence, the task's link and the change and stop links", async () => {
    const w = await world();
    await w.needsYou(0);
    expect(await w.deliver()).toMatchObject({ people: 1, emails: 1, sent: 0 });
    const [mail] = w.fake.sent();
    expect(mail).toMatchObject({ companyId: ORG, purpose: "attention", to: ADDRESS, subject: "Rovara: 1 task needs your attention", unsubscribeUrl: "https://rovara.example/app/account?notify=unsubscribe#notifications" });
    const lines = mail!.text.split("\n");
    expect(lines.slice(0, 2)).toEqual(["A task needs your attention in Rovara:", ""]);
    expect(lines[2]).toMatch(/^- Add retry: Needs you/u);
    expect(lines[3]).toBe(`  https://rovara.example/app/sessions/${w.tasks[0]!.sessionId}`);
    expect(lines.slice(-2)).toEqual(["Change how you're notified: https://rovara.example/app/account#notifications", "Stop these emails: https://rovara.example/app/account?notify=unsubscribe#notifications"]);
    expect(mail!.text).not.toContain(SECRET_STEP);
    const links = mail!.text.match(/https?:\/\/\S+/gu) ?? [];
    expect(links).toHaveLength(3);
    expect(links.every((link) => link.startsWith("https://rovara.example/app"))).toBe(true);
    expect(w.chat.delivered).toHaveLength(0);
    expect(await w.pending()).toHaveLength(0);
  });

  it("falls back to the chats when the email point cannot send (Code's default), when the person has no address, or after the unsubscribe", async () => {
    const none = await world({ email: createUnavailableEmailSender() });
    await none.prefs({ targets: [chatTarget], channel: "email" });
    await none.needsYou(0);
    expect(await none.deliver()).toMatchObject({ emails: 0, sent: 1 });
    expect(none.chat.delivered).toHaveLength(1);
    // No email point registered at all: the same.
    const missing = await world({ email: "none" });
    await missing.prefs({ targets: [chatTarget], channel: "email" });
    await missing.needsYou(0);
    expect(await missing.deliver()).toMatchObject({ emails: 0, sent: 1 });
    // The point can send, but the person has no address of their own (or one that is not a plain address).
    for (const address of [undefined, "Owner <owner@example.com>"]) {
      const bare = await world();
      await bare.prefs({ targets: [chatTarget], channel: "email" });
      await bare.needsYou(0);
      expect(await bare.deliver({ address: async () => address })).toMatchObject({ emails: 0, sent: 1 });
      expect(bare.fake.sent()).toEqual([]);
    }
    // Unsubscribed with a chat: the chat; unsubscribed with no chat: nowhere, and the rows go (Home still lists the task).
    const stopped = await world();
    await stopped.prefs({ targets: [chatTarget], channel: "email" });
    await stopped.prefs({ emailUnsubscribed: true });
    await stopped.needsYou(0);
    expect(await stopped.deliver()).toMatchObject({ emails: 0, sent: 1 });
    const silent = await world();
    await silent.prefs({ channel: "email" });
    await silent.prefs({ emailUnsubscribed: true });
    await silent.needsYou(0);
    expect(await silent.deliver()).toMatchObject({ emails: 0, sent: 0, people: 0 });
    expect(await silent.pending()).toHaveLength(0);
    // The rule itself is the hosted product's.
    expect(effectiveNotify({ channel: "email", slackLinked: true, emailAvailable: false, emailUnsubscribed: false })).toEqual({ slack: true, email: false });
  });

  it("follows a chat choice even where email could be sent, and sends both for both", async () => {
    const chatOnly = await world();
    await chatOnly.prefs({ targets: [chatTarget], channel: "slack" });
    await chatOnly.needsYou(0);
    expect(await chatOnly.deliver()).toMatchObject({ emails: 0, sent: 1 });
    // A person with a chat place and no choice gets the chat (the default when they can be reached in a chat).
    const byDefault = await world();
    await byDefault.prefs({ targets: [chatTarget] });
    await byDefault.needsYou(0);
    expect(await byDefault.deliver()).toMatchObject({ emails: 0, sent: 1 });
    const both = await world();
    await both.prefs({ targets: [chatTarget], channel: "both" });
    await both.needsYou(0);
    expect(await both.deliver()).toMatchObject({ people: 1, emails: 1, sent: 1 });
    expect(await both.pending()).toHaveLength(0);
  });

  it("I1: a failing email never holds back the chat, is tried again after a growing wait, gives up after its tries, and is never sent again", async () => {
    const w = await world();
    await w.prefs({ targets: [chatTarget], channel: "both" });
    await w.needsYou(0);
    w.fake.setDown(true);
    expect(await w.deliver()).toMatchObject({ sent: 1, emails: 0, failed: 1 });
    expect(await w.pending()).toHaveLength(1);
    // The claim was given back: the row is not marked as emailed.
    expect((await w.pending())[0]!["emailClaimed"]).toBeUndefined();
    // Too soon for the retry: nothing is tried.
    w.clock.ms += ATTENTION_RETRY_BASE_MS - 1_000;
    expect(await w.deliver()).toMatchObject({ sent: 0, emails: 0, failed: 0 });
    // After the wait the email is tried again; the chat is not sent twice.
    w.clock.ms += NOTIFY_BATCH_MINUTES * 60_000;
    expect(await w.deliver()).toMatchObject({ sent: 0, emails: 0, failed: 1 });
    let gaveUp = 0;
    for (let attempt = 3; attempt <= ATTENTION_TARGET_TRIES_MAX; attempt += 1) {
      w.clock.ms += ATTENTION_RETRY_BASE_MS * 2 ** (attempt - 1) + NOTIFY_BATCH_MINUTES * 60_000;
      gaveUp += (await w.deliver()).gaveUp;
    }
    expect(gaveUp).toBe(1);
    expect(await w.pending()).toHaveLength(0);
    expect(w.chat.delivered).toHaveLength(1);
  });

  it("I1/N2: an email that went out is not sent again when the chat fails, nor when its sent-mark is lost (the claim counts)", async () => {
    const w = await world();
    const flaky = new FakeChannelAdapter();
    let fail = true;
    const original = flaky.deliver.bind(flaky);
    flaky.deliver = async (event) => { if (fail) throw new Error("down"); await original(event); };
    w.registry.unregister("channel", "examplechat");
    w.registry.register("channel", "examplechat", flaky);
    await w.prefs({ targets: [chatTarget], channel: "both" });
    await w.needsYou(0);
    expect(await w.deliver()).toMatchObject({ emails: 1, sent: 0, failed: 1 });
    expect((await w.pending())[0]).toMatchObject({ emailSent: true });
    // A row the hosted product claimed (its `emailClaimed`) with no sent-mark counts as emailed too.
    await w.store.update({ key: { pk: PENDING_PK, sk: (await w.pending())[0]!.sk }, ops: [{ op: "remove", path: ["emailSent"] }, { op: "remove", path: ["doneTargets"] }] });
    expect(typeof (await w.pending())[0]!["emailClaimed"]).toBe("number");
    fail = false;
    w.clock.ms += NOTIFY_BATCH_MINUTES * 60_000 + ATTENTION_RETRY_BASE_MS;
    expect(await w.deliver()).toMatchObject({ emails: 0, sent: 1 });
    expect(w.fake.sent()).toHaveLength(1);
    expect(await w.pending()).toHaveLength(0);
  });

  it("claims the rows of one email all at once: a claim that fails part-way claims none, and a row that changed is left for later, so no task is lost", async () => {
    const w = await world({ startMs: Date.parse("2026-11-09T10:05:00.000Z") });
    await w.needsYou(0);
    await w.needsYou(1);
    // A store that refuses the second row's claim when claimed row by row, and fails the first transaction outright.
    const realUpdate = w.store.update.bind(w.store), realTransact = w.store.transact.bind(w.store);
    let claims = 0, transactFailures = 1;
    w.store.update = async (request) => { if (request.ops.some((op) => op.path[0] === "emailClaimed" && op.op === "set") && ++claims === 2) throw new Error("throttled"); return realUpdate(request); };
    w.store.transact = async (items) => { if (transactFailures-- > 0) throw new Error("throttled"); return realTransact(items); };
    expect(await w.deliver()).toMatchObject({ emails: 0 });
    expect(w.fake.sent()).toEqual([]);
    // Nothing was claimed, so nothing is taken as emailed.
    expect((await w.pending()).map((row) => row["emailClaimed"])).toEqual([undefined, undefined]);
    w.clock.ms += NOTIFY_BATCH_MINUTES * 60_000 + 1;
    expect(await w.deliver()).toMatchObject({ emails: 1 });
    expect(w.fake.sent()[0]!.text).toContain("Add retry");
    expect(w.fake.sent()[0]!.text).toContain("Fix login");
    // A row replaced between the read and the claim is left out of this email and sent with a later one; the other is claimed and sent.
    const r = await world({ startMs: Date.parse("2026-11-09T10:05:00.000Z") });
    await r.needsYou(0);
    await r.needsYou(1);
    const inner = r.store.transact.bind(r.store);
    let raced = false;
    r.store.transact = async (items) => {
      if (!raced) { raced = true; const second = items[1] as { key: { pk: string; sk: string } }; await r.store.update({ key: second.key, ops: [{ op: "set", path: ["at"], value: "2026-11-09T10:06:00.000Z" }] }); }
      return inner(items);
    };
    expect(await r.deliver()).toMatchObject({ emails: 1 });
    expect(await r.pending()).toHaveLength(1);
    expect((await r.pending())[0]!["emailClaimed"]).toBeUndefined();
    r.clock.ms += NOTIFY_BATCH_MINUTES * 60_000 + 1;
    expect(await r.deliver()).toMatchObject({ emails: 1 });
    expect(r.fake.sent()).toHaveLength(2);
    expect(await r.pending()).toHaveLength(0);
  });

  it("gives up at once on an email the sender refuses (never retried)", async () => {
    const w = await world({ email: { capabilities: { available: true, html: false, unsubscribeHeader: false }, send: async () => { throw new EmailError("refused", "the recipient is not one plain address"); } } });
    await w.needsYou(0);
    expect(await w.deliver()).toMatchObject({ emails: 0, gaveUp: 1, failed: 0 });
    expect(await w.pending()).toHaveLength(0);
  });

  it("names a finished task as finished in the email's subject and text", () => {
    const mail = attentionEmail([{ title: "Add retry", status: "Merged" }], 0, "done");
    expect(mail.subject).toBe("Rovara: 1 task finished");
    expect(mail.text.startsWith("A task finished in Rovara:")).toBe(true);
    // A link that is not plain https is left out.
    expect(attentionEmail([{ title: "x", status: "y", link: "http://insecure.example/a" }], 2, "attention", { home: "javascript:alert(1)", settings: "https://u:p@rovara.example/" }).text).not.toMatch(/http:|javascript:|u:p@/u);
  });
});

describe("quiet hours", () => {
  // 23:00 in Berlin on 2026-11-09 is 22:00 UTC (standard time, UTC+1).
  const at = (iso: string) => Date.parse(iso);

  it("holds a question at 23:00 and sends it at 07:00, in one batch with what else came in the night", async () => {
    const w = await world({ startMs: at("2026-11-09T21:59:00.000Z") });
    await w.prefs({ targets: [chatTarget], quietHours: { start: "22:00", end: "07:00" }, timeZone: "Europe/Berlin" });
    await w.needsYou(0);
    expect(await w.deliver()).toMatchObject({ sent: 0, held: 1 });
    w.clock.ms = at("2026-11-10T01:30:00.000Z");
    await w.needsYou(1);
    expect(await w.deliver()).toMatchObject({ sent: 0, held: 2 });
    expect(await w.pending()).toHaveLength(2);
    // 06:59 local is still quiet.
    w.clock.ms = at("2026-11-10T05:59:00.000Z");
    expect(await w.deliver()).toMatchObject({ sent: 0, held: 2 });
    // 07:00 local: both, one message.
    w.clock.ms = at("2026-11-10T06:00:00.000Z");
    expect(await w.deliver()).toMatchObject({ people: 1, sent: 1, held: 0 });
    expect(w.chat.delivered).toHaveLength(1);
    expect(textOf(w.chat.delivered[0]!)).toContain("Add retry");
    expect(textOf(w.chat.delivered[0]!)).toContain("Fix login");
    expect(await w.pending()).toHaveLength(0);
  });

  it("lets an urgent item break through (owner answer Q20), and holds when the urgency check fails", async () => {
    const w = await world({ startMs: at("2026-11-09T22:30:00.000Z") });
    await w.prefs({ targets: [chatTarget], quietHours: { start: "22:00", end: "07:00" }, timeZone: "Europe/Berlin" });
    await w.needsYou(0);
    await w.needsYou(1);
    const urgentSession = w.tasks[1]!.sessionId;
    const seen: unknown[] = [];
    expect(await w.deliver({ urgent: async (_org: OrgId, row: { sessionId: string }) => { seen.push(row); return row.sessionId === urgentSession; } })).toMatchObject({ sent: 1, held: 1 });
    expect(textOf(w.chat.delivered[0]!)).toContain("Fix login");
    expect(textOf(w.chat.delivered[0]!)).not.toContain("Add retry");
    expect(seen).toContainEqual({ developerId: OWNER_ID, sessionId: urgentSession, kind: "needs_you" });
    w.clock.ms += NOTIFY_BATCH_MINUTES * 60_000 + 1;
    expect(await w.deliver({ urgent: async () => { throw new Error("down"); } })).toMatchObject({ sent: 0, held: 1 });
  });

  it("reads the hours on the person's own clock", async () => {
    // 22:30 UTC is quiet in London (22:30) but not in New York (17:30).
    for (const [zone, held] of [["Europe/London", 1], ["America/New_York", 0]] as const) {
      const w = await world({ startMs: at("2026-11-09T22:29:00.000Z") });
      await w.prefs({ targets: [chatTarget], quietHours: { start: "22:00", end: "07:00" }, timeZone: zone });
      await w.needsYou(0);
      expect(await w.deliver()).toMatchObject({ held, sent: 1 - held });
    }
  });

  it("a muted person is not held, only dropped", async () => {
    const w = await world({ startMs: at("2026-11-09T22:30:00.000Z") });
    await w.prefs({ targets: [chatTarget], muted: true, quietHours: { start: "22:00", end: "07:00" } });
    await w.needsYou(0);
    expect(await w.deliver()).toMatchObject({ sent: 0, held: 0 });
    expect(await w.pending()).toHaveLength(0);
  });

  it("the span's edges: the start is quiet, the end is not, and a span may cross midnight", () => {
    const night = { start: "22:00", end: "07:00" }, day = { start: "12:00", end: "13:30" };
    expect([21 * 60 + 59, 22 * 60, 0, 6 * 60 + 59, 7 * 60].map((minute) => inQuietHours(night, minute))).toEqual([false, true, true, true, false]);
    expect([11 * 60 + 59, 12 * 60, 13 * 60 + 29, 13 * 60 + 30].map((minute) => inQuietHours(day, minute))).toEqual([false, true, true, false]);
    expect(inQuietHours(undefined, 0)).toBe(false);
    expect(localClock(Date.parse("2026-03-29T01:30:00.000Z"), "Europe/Berlin")).toEqual({ day: "2026-03-29", minute: 3 * 60 + 30 });
    expect(localClock(Date.parse("2026-11-09T23:30:00.000Z"), "Asia/Tokyo")).toEqual({ day: "2026-11-10", minute: 8 * 60 + 30 });
  });
});

describe("the daily digest", () => {
  it("holds what is not urgent until the digest time, sends it as one digest, then holds again until the next day's", async () => {
    const w = await world({ startMs: Date.parse("2026-11-09T07:00:00.000Z") });
    await w.prefs({ targets: [chatTarget], digestAt: "09:00", timeZone: "UTC" });
    await w.needsYou(0);
    expect(await w.deliver()).toMatchObject({ sent: 0, held: 1 });
    w.clock.ms = Date.parse("2026-11-09T09:00:30.000Z");
    await w.needsYou(1);
    expect(await w.deliver()).toMatchObject({ sent: 1 });
    const text = textOf(w.chat.delivered[0]!);
    expect(text.startsWith("Your Rovara digest:")).toBe(true);
    expect(text).toContain("Add retry");
    expect(text).toContain("Fix login");
    expect(w.chat.delivered[0]!.type).toBe("progress");
    // Later that day: held for tomorrow's digest.
    w.clock.ms = Date.parse("2026-11-09T15:00:00.000Z");
    await w.move(0, { workflow: { stage: "IMPLEMENT", state: "RUNNING" } });
    await w.move(0, { workflow: { stage: "PLAN_REVIEW", state: "WAITING" } });
    expect(await w.deliver()).toMatchObject({ sent: 0, held: 1 });
    w.clock.ms = Date.parse("2026-11-10T08:59:00.000Z");
    expect(await w.deliver()).toMatchObject({ sent: 0, held: 1 });
    w.clock.ms = Date.parse("2026-11-10T09:01:00.000Z");
    expect(await w.deliver()).toMatchObject({ sent: 1 });
    expect(w.chat.delivered).toHaveLength(2);
  });

  it("emails the digest with its own subject when email is chosen", async () => {
    const w = await world({ startMs: Date.parse("2026-11-09T09:30:00.000Z") });
    await w.prefs({ channel: "email", digestAt: "09:00" });
    await w.needsYou(0);
    expect(await w.deliver()).toMatchObject({ emails: 1 });
    expect(w.fake.sent()[0]).toMatchObject({ subject: "Rovara digest: 1 task" });
    expect(w.fake.sent()[0]!.text.startsWith("Your Rovara digest:")).toBe(true);
  });

  it("on New York's daylight-saving days the digest is never early and its slot is never skipped", () => {
    const ny = { timeZone: "America/New_York", digestAt: "02:00" };
    // Fall back, 2026-11-01: 01:30 happens twice. The second 01:30 (EST, 06:30Z) is still before 02:00, so yesterday's slot is the latest: already served, the digest waits.
    expect(localClock(Date.parse("2026-11-01T06:30:00.000Z"), ny.timeZone)).toEqual({ day: "2026-11-01", minute: 90 });
    expect(holdOf(ny, Date.parse("2026-11-01T05:30:00.000Z"), "2026-10-31")).toBe("digest");
    expect(holdOf(ny, Date.parse("2026-11-01T06:30:00.000Z"), "2026-10-31")).toBe("digest");
    expect(digestSlotDay(ny, Date.parse("2026-11-01T06:30:00.000Z"))).toBe("2026-10-31");
    // 02:00 EST arrives: today's slot.
    expect(holdOf(ny, Date.parse("2026-11-01T07:00:00.000Z"), "2026-10-31")).toBe("none");
    expect(digestSlotDay(ny, Date.parse("2026-11-01T07:00:00.000Z"))).toBe("2026-11-01");
    // Spring forward, 2026-03-08: 02:00 to 03:00 does not exist. A 02:30 digest is served at the first sweep after it (03:00 EDT), not skipped to the next day.
    const spring = { timeZone: "America/New_York", digestAt: "02:30" };
    expect(holdOf(spring, Date.parse("2026-03-08T06:59:00.000Z"), "2026-03-07")).toBe("digest");
    expect(holdOf(spring, Date.parse("2026-03-08T07:00:00.000Z"), "2026-03-07")).toBe("none");
    expect(digestSlotDay(spring, Date.parse("2026-03-08T07:00:00.000Z"))).toBe("2026-03-08");
    expect(holdOf(spring, Date.parse("2026-03-08T07:00:00.000Z"), "2026-03-08")).toBe("digest");
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
    expect(dayBefore("2028-01-01")).toBe("2027-12-31");
  });

  it("a slot that falls in quiet hours is served when they end; a slot is never served twice; a first digest waits for today's slot", () => {
    const prefs = { quietHours: { start: "22:00", end: "07:00" }, timeZone: "UTC", digestAt: "23:00" };
    expect(holdOf(prefs, Date.parse("2026-11-09T23:00:00.000Z"), "2026-11-08")).toBe("quiet");
    expect(holdOf(prefs, Date.parse("2026-11-10T07:00:00.000Z"), "2026-11-08")).toBe("none");
    expect(digestSlotDay(prefs, Date.parse("2026-11-10T07:00:00.000Z"))).toBe("2026-11-09");
    expect(holdOf(prefs, Date.parse("2026-11-10T07:00:00.000Z"), "2026-11-09")).toBe("digest");
    const morning = { timeZone: "UTC", digestAt: "09:00" };
    expect(holdOf(morning, Date.parse("2026-11-10T08:00:00.000Z"), undefined)).toBe("digest");
    expect(holdOf(morning, Date.parse("2026-11-10T09:00:00.000Z"), undefined)).toBe("none");
    expect(holdOf({}, Date.parse("2026-11-10T03:00:00.000Z"), undefined)).toBe("none");
  });
});

describe("realtime hint", () => {
  it("tells the person's pages that what waits for them changed, with ids only, and a broken push never fails the queue", async () => {
    const w = await world();
    await w.needsYou(0);
    const heard = w.realtime.published();
    expect(heard).toEqual([{ companyId: ORG, audience: { kind: "person", personId: OWNER_ID }, notice: { type: "attention.changed", sessionId: w.tasks[0]!.sessionId, kind: "needs_you" } }]);
    expect(isRealtimeNotice(attentionNotice(w.tasks[0]!.sessionId, "needs_you"))).toBe(true);
    expect(JSON.stringify(heard)).not.toMatch(/Add retry|sk-notes|example\.com/u);
    const broken = await world();
    broken.realtime.publish = async () => { throw new Error("down"); };
    await broken.needsYou(0);
    expect(await broken.pending()).toHaveLength(1);
  });

  it("the email route has its own key, never a chat target's", () => {
    expect(EMAIL_TARGET).not.toContain(":");
  });
});
