// Lead 4 N1: the admins' notice of a nightly upkeep pause. ONE attention event per (company, project, month, reason), kind `upkeep_paused`, to the project's admins and the company's owners and admins, in fixed
// words with the project's name and a link to Spending limits, deduped by that key, through Code's attention queue (core/notify/attention.ts). Mutants are listed in the PR body with the test that kills each.
import { describe, expect, it } from "vitest";
import { UPKEEP_NOTICE_WORDS, UPKEEP_PAUSE_MESSAGES, queryAll, upkeepSubjectId, upkeepSubjectOf, type ConversationRef, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { PENDING_PK, attentionText, deliverAttention, queueUpkeepPaused, writeNotifyPrefs } from "../../packages/broker/src/core/notify/index.js";
import { attentionEmail } from "../../packages/broker/src/core/notify/email-text.js";
import { upkeepNoticeKey } from "../../packages/broker/src/core/upkeep/keys.js";
import { createNoticeService } from "../../packages/broker/src/services/notices.js";

const COMPANY_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ADMIN_1 = "a1".repeat(32);
const ADMIN_2 = "a2".repeat(32);
const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };
const clock = { ms: Date.parse("2026-11-17T04:30:00.000Z") };

function world(recipients: (orgId: OrgId, project: string) => Promise<readonly string[]> = async () => [ADMIN_1, ADMIN_2]) {
  const store = new MemoryDocumentStore();
  const registry = createAdapterRegistry();
  const adapter = new FakeChannelAdapter();
  registry.register("channel", "examplechat", adapter);
  const logs: Array<Record<string, unknown>> = [];
  const queue = (orgId: OrgId, project: string, reason: "no_budget" | "monthly_limit" | "cost_too_high", month?: string) =>
    queueUpkeepPaused({ store, now: () => new Date(clock.ms), log: (entry) => logs.push(entry), recipients }, { orgId, project, reason, ...(month === undefined ? {} : { month }) });
  const prefs = async (orgId: OrgId, person: string) => { await writeNotifyPrefs({ store, now: () => new Date(clock.ms) }, orgId, person, { targets: [{ channel: CONVERSATION.channel, conversation: CONVERSATION }], muted: false }); };
  const deliver = (upkeep: Parameters<typeof deliverAttention>[0]["upkeep"]) => deliverAttention({ store, registry, now: () => clock.ms, log: () => undefined, ...(upkeep === undefined ? {} : { upkeep }) });
  const pending = async () => (await store.query({ pk: PENDING_PK })).items;
  return { store, adapter, queue, prefs, deliver, pending, logs };
}
const ADMINS = { administers: async () => true, link: (project: string) => `https://example.test/projects/${project}/spending-limits` };

describe("one notice per company, project, month and reason", () => {

  it("keeps only person ids (64 hex), never more than the cap, and gives the marker back when nobody could be told or the read failed", async () => {
    const none = world(async () => ["not-a-person", "ADMIN", ""]);
    expect(await none.queue(COMPANY_A, "beacon", "monthly_limit")).toEqual({ queued: 0, deduped: false });
    expect(await none.store.get(upkeepNoticeKey({ orgId: COMPANY_A, project: "beacon" }, "2026-11", "monthly_limit"))).toBeUndefined();
    let attempts = 0;
    const flaky = world(async () => { attempts += 1; if (attempts === 1) throw new Error("directory down"); return [ADMIN_1]; });
    expect(await flaky.queue(COMPANY_A, "beacon", "monthly_limit")).toEqual({ queued: 0, deduped: false });
    expect(flaky.logs.map((entry) => entry["event"])).toContain("upkeep.notice_recipients_failed");
    // A later night tries again and writes the notice (the marker was given back).
    expect(await flaky.queue(COMPANY_A, "beacon", "monthly_limit")).toEqual({ queued: 1, deduped: false });
    const many = world(async () => Array.from({ length: 80 }, (_, index) => index.toString(16).padStart(64, "0")));
    expect((await many.queue(COMPANY_A, "beacon", "monthly_limit")).queued).toBe(50);
  });

  it("never throws: a project name that is not a project name queues nothing", async () => {
    const w = world();
    expect(await w.queue(COMPANY_A, "Bad#Name", "monthly_limit")).toEqual({ queued: 0, deduped: false });
    expect(await w.pending()).toHaveLength(0);
    expect(w.logs.map((entry) => entry["event"])).toContain("upkeep.notice_failed");
  });
});

describe("delivery: fixed words, the project's name, a link, and only to people who still administer the project", () => {

  it("a host with no upkeep wiring leaves the row waiting instead of dropping it, and a later host with the wiring delivers it", async () => {
    const w = world();
    await w.prefs(COMPANY_A, ADMIN_1);
    await w.queue(COMPANY_A, "beacon", "monthly_limit");
    expect((await w.deliver(undefined)).sent).toBe(0);
    expect(await w.pending()).toHaveLength(2);
    expect((await w.deliver(ADMINS)).sent).toBe(1);
  });

  it("a write failure of the rows leaves no marker and no partial notice: a later night writes it", async () => {
    const w = world();
    let fail = true;
    const transact = w.store.transact.bind(w.store);
    w.store.transact = async (items) => { if (fail) { fail = false; throw new Error("store down"); } return transact(items); };
    expect(await w.queue(COMPANY_A, "beacon", "monthly_limit")).toEqual({ queued: 0, deduped: false });
    expect(await w.pending()).toHaveLength(0);
    expect(await w.queue(COMPANY_A, "beacon", "monthly_limit")).toEqual({ queued: 2, deduped: false });
  });

  it("drops the row for a person who no longer administers the project, or when the host cannot tell", async () => {
    const w = world();
    await w.prefs(COMPANY_A, ADMIN_1);
    await w.queue(COMPANY_A, "beacon", "monthly_limit");
    expect((await w.deliver({ administers: async () => false })).sent).toBe(0);
    expect(w.adapter.delivered).toHaveLength(0);
    expect(await w.pending()).toHaveLength(0);
    const w2 = world();
    await w2.prefs(COMPANY_A, ADMIN_1);
    await w2.queue(COMPANY_A, "beacon", "monthly_limit");
    expect((await w2.deliver({ administers: async () => { throw new Error("down"); } })).sent).toBe(0);
    expect(w2.adapter.delivered).toHaveLength(0);
  });

  it("the notice service carries the upkeep wiring to the delivery sweep (a host composes it there)", async () => {
    const w = world();
    await w.prefs(COMPANY_A, ADMIN_1);
    await w.queue(COMPANY_A, "beacon", "cost_too_high");
    const registry = createAdapterRegistry();
    registry.register("channel", "examplechat", w.adapter);
    const service = createNoticeService({ store: w.store, registry, now: () => new Date(clock.ms), log: () => undefined, upkeep: ADMINS });
    expect((await service.deliver())?.sent).toBe(1);
    expect((w.adapter.delivered[0]!.data as { text: string }).text).toContain(UPKEEP_NOTICE_WORDS.cost_too_high);
  });

  it("a muted person is told nowhere and the row goes", async () => {
    const w = world();
    await writeNotifyPrefs({ store: w.store, now: () => new Date(clock.ms) }, COMPANY_A, ADMIN_1, { targets: [{ channel: CONVERSATION.channel, conversation: CONVERSATION }], muted: true });
    await w.queue(COMPANY_A, "beacon", "monthly_limit");
    await w.deliver(ADMINS);
    expect(w.adapter.delivered).toHaveLength(0);
    expect(await queryAll(w.store, { pk: PENDING_PK })).toHaveLength(0);
  });

  it("a row that is not an upkeep subject, or an upkeep subject on a task kind, reads as nothing", async () => {
    const w = world();
    await w.prefs(COMPANY_A, ADMIN_1);
    const at = new Date(clock.ms).toISOString();
    await w.store.put({ item: { pk: PENDING_PK, sk: `${COMPANY_A}#${ADMIN_1}#session-1#upkeep_paused`, entityType: "NOTIFY_PENDING", orgId: COMPANY_A, developerId: ADMIN_1, sessionId: "session-1", kind: "upkeep_paused", at } });
    const subject = upkeepSubjectId({ project: "beacon", month: "2026-11", reason: "monthly_limit" });
    await w.store.put({ item: { pk: PENDING_PK, sk: `${COMPANY_A}#${ADMIN_1}#${subject}#failed`, entityType: "NOTIFY_PENDING", orgId: COMPANY_A, developerId: ADMIN_1, sessionId: subject, kind: "failed", at } });
    expect((await w.deliver(ADMINS)).sent).toBe(0);
    expect(w.adapter.delivered).toHaveLength(0);
  });
});

describe("words", () => {
  it("the email says upkeep, not task, and a mixed list says items", () => {
    const upkeep = { title: "beacon", status: UPKEEP_NOTICE_WORDS.monthly_limit, link: "https://example.test/x", kind: "upkeep_paused" };
    const mail = attentionEmail([upkeep], 0, "attention");
    expect(mail.subject).toBe("Rovara: nightly upkeep needs your attention");
    expect(mail.text).toContain("Nightly upkeep needs your attention in Rovara:");
    expect(attentionEmail([upkeep, { title: "Add retry", status: "Needs you", kind: "needs_you" }], 0, "attention").text).toContain("These items need your attention in Rovara:");
    // A list with no upkeep line keeps today's words.
    expect(attentionEmail([{ title: "Add retry", status: "Needs you" }], 0, "attention").subject).toBe("Rovara: 1 task needs your attention");
    expect(attentionText([{ title: "Add retry", status: "Needs you", kind: "needs_you" }], 0, 500)).toMatch(/^A task needs your attention in Rovara:/u);
  });

  it("the subject id round-trips, and a session id is never read as one", () => {
    const subject = upkeepSubjectId({ project: "beacon", month: "2026-11", reason: "cost_too_high" });
    expect(upkeepSubjectOf(subject)).toEqual({ project: "beacon", month: "2026-11", reason: "cost_too_high" });
    expect(upkeepSubjectOf("ses_8b579b4beaa74bf287bc6da86b97c9e6")).toBeUndefined();
    expect(upkeepSubjectOf("upkeep-2026-13-no_budget-beacon")).toBeUndefined();
    expect(Object.values(UPKEEP_NOTICE_WORDS).every((words) => !/\p{Pd}\s/u.test(words) && !words.includes("—"))).toBe(true);
    expect(Object.keys(UPKEEP_NOTICE_WORDS)).toEqual(Object.keys(UPKEEP_PAUSE_MESSAGES));
  });
});
