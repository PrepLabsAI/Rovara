// L4-U5d: the broker's own part of a later message in a Slack thread whose task the core owns. The thread's guard row (`SHARED_TASK`) names the task and the company whose core start wrote it; a task stamped `core` takes the reply
// through `CoreTaskEntry.threadInput` as the Slack person's linked Rovara person, and never through the old thread-note path (which refused it: "couldn't save this reply"). A reply for a thread of another company, from a person who is
// not linked, for a closed thread or for a task the guard row does not name reaches the core with nothing. The core's own rule and routing are tested in tests/unit/chat-thread-input.test.ts.
// Mutants are listed in briefs/lead4/L4-U5d-MUTANTS-20261118.md with the test that kills each.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, SLACK_CHANNEL as SLACK, sharedTaskKey } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { issueChannelLinkCode, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/links.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { coreTaskMarkKey } from "../../packages/broker/src/core-host/core-task-mark.js";
import type { CoreEntryCaller, CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import type { ChatThreadInput, ChatThreadInputResult } from "../../packages/broker/src/core-host/chat-thread-input.js";
import { bindSlackChannelInCompany, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, loadSlackBroker } from "../support/slack-broker.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const USER = "U0SHARED00";
const STRANGER = "U0STRANGER0";
const PERSON = "a".repeat(64);
const TASK = "11111111-1111-4111-8111-111111111111";
const OTHER_TASK = "22222222-2222-4222-8222-222222222222";
const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1700000000.000001" };
const CORE = { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "x", stampedAt: "2026-11-18T00:00:00.000Z" };

beforeAll(async () => { await loadSlackBroker(); });

/** A company-mode broker (one Slack workspace of company A, one linked person) over a fake core entry that records each reply it is given. */
async function world(options: { entry?: "none" | "no-thread-input"; stamp?: boolean; guard?: Record<string, unknown> | null; company?: string; installTeam?: true } = {}) {
  const h = await createDeveloperTaskBroker({ channelMembers: async (r) => ({ ok: true, memberOf: r.channelIds }) });
  const store = new MemoryDocumentStore();
  const company = options.company ?? A;
  // DEC 254zzz80: a NAMED company's channel binding lives in its own partition.
  bindSlackChannelInCompany(h.db, company);
  const workspaces = { store, getProject: async () => ({ companyId: company }), linkUrl: (code: string) => `https://example.test/review/link/${code}`,
    requireCompany: async (team: string): Promise<string> => { if (team !== SLACK_TEAM) throw Error("private"); return company; }, tokenForEvent: vi.fn(async () => ({ companyId: company, token: "x" })) };
  const code = await issueChannelLinkCode({ store, orgId: company, now: Date.now }, { channel: "slack", tenant: SLACK_TEAM, userId: USER });
  await redeemChannelLinkCode({ store, orgId: company, now: Date.now }, PERSON, code.code);
  const calls: Array<{ caller: unknown; input: Record<string, unknown> }> = [];
  const answerWith: { value: ChatThreadInputResult | Error } = { value: { outcome: "captured", notice: "note_saved" } };
  const decisions: unknown[] = [];
  const entry: CoreTaskEntry = {
    route: vi.fn(async () => undefined),
    chatDecision: vi.fn(async (caller: CoreEntryCaller) => { decisions.push(caller); return { outcome: "decided" as const }; }),
    ...(options.entry === "no-thread-input" ? {} : {
      threadInput: vi.fn(async (caller: CoreEntryCaller, input: ChatThreadInput) => {
        calls.push({ caller, input: { ...input } });
        if (answerWith.value instanceof Error) throw answerWith.value;
        return answerWith.value;
      }),
    }),
  };
  const module = await loadSlackBroker();
  const handler = module.createAwsBrokerHandler({ ...h.brokerInput, store, workspaces, companies: { companyOf: async (id: string) => (id === PERSON ? company : undefined) },
    // DEC 254zzz95: `installTeam`: SLACK_TEAM is the install's own team (its legacy view), as on staging.
    ...(options.installTeam === true ? { slackWorkspaceLegacyTeamId: SLACK_TEAM } : {}),
    developer: { ...h.brokerInput.developer!, slackTeamId: options.installTeam === true ? SLACK_TEAM : "T0OTHER000", ...(options.entry === "none" ? {} : { coreTasks: entry }) } } as never);
  if (options.stamp !== false) h.db.set({ ...coreTaskMarkKey(TASK), coreEngine: CORE });
  if (options.guard !== null) {
    h.db.set({
      ...sharedTaskKey(thread), entityType: "SHARED_TASK", taskId: TASK, workspaceId: randomUUID(), ownerKey: taskOwnerKey(PERSON, TASK), developerId: PERSON, developerName: "Rovara member", project: "payments",
      mode: "continue", sharedAt: new Date().toISOString(), workflowThread: true, companyId: A, startRequestId: randomUUID(), ...(options.guard ?? {}),
    });
  }
  const note = (extra: Record<string, unknown> = {}) => handler({
    source: "agentx.slack-ingress", action: "thread-note", taskId: TASK, userId: USER, thread, eventId: "EvNote0001", messageTs: "1700000001.000100", text: "Also cover the 404 case.", ...extra,
  });
  /** A core plan press (the interactivity Lambda's invoke), APPROVE in this thread. */
  const press = (actorTenant = SLACK_TEAM) => handler({ source: "agentx.slack-ingress", action: "core-plan-press", press: {
    conversation: { channel: SLACK, tenant: SLACK_TEAM, space: SLACK_CHANNEL, thread: thread.threadTs }, actor: { channel: SLACK, tenant: actorTenant, userId: USER },
    eventId: "EvPress0001", requestId: randomUUID(), expectedRevision: 1, artifactDigest: "c".repeat(64), decision: "APPROVE", reason: "",
  } });
  return { ...h, handler, entry, calls, answerWith, note, press, decisions, store, workspaces };
}

describe("DEC 254zzz95: the install team of a NAMED company runs its thread follow-ups as that company", () => {

  it("a core plan press whose actor names another workspace is not switched, and is refused before the core", async () => {
    const w = await world({ installTeam: true });
    const result = await w.press("T0ELSEWHERE");
    expect(JSON.parse(result.body)).toEqual({ status: "refused", reason: "not_allowed" });
    expect(w.decisions).toEqual([]);
  });

  it("an install team whose company cannot be read answers a retryable error and reaches nothing (never the legacy view's guess)", async () => {
    const w = await world({ installTeam: true });
    w.workspaces.requireCompany = async () => { throw new Error("refused"); };
    const result = await w.note({ mention: true });
    expect(result.statusCode).toBe(503);
    expect(w.calls).toEqual([]);
    expect((await w.press()).statusCode).toBe(503);
    expect(w.decisions).toEqual([]);
  });

  it("the built-in company's install team keeps the legacy view: the core's input is never reached as a linked person", async () => {
    const w = await world({ installTeam: true, company: IMPLICIT_COMPANY_ID });
    await w.note({ mention: true });
    expect(w.calls.filter((call) => (call.caller as { developerId?: string }).developerId === PERSON)).toEqual([]);
    // The legacy view did run: a core press there is decided as the Slack account's own (legacy) caller, never the linked person.
    expect((await w.press()).statusCode).toBe(200);
    expect(w.decisions).toHaveLength(1);
    expect(w.decisions).not.toEqual([expect.objectContaining({ developerId: PERSON })]);
  });
});

describe("a reply in the thread of a task the core owns", () => {

  it("every outcome and notice of the core is passed on as it is (answers, refusals, duplicates)", async () => {
    const w = await world();
    for (const value of [
      { outcome: "captured", notice: "answers_saved" }, { outcome: "captured", notice: "plan_note_saved" }, { outcome: "duplicate" }, { outcome: "small_talk" },
      { outcome: "refused", notice: "not_allowed" }, { outcome: "refused", notice: "answers_unclear" }, { outcome: "refused", notice: "rate_limited" }, { outcome: "refused", notice: "not_saved" },
    ] as const) {
      w.answerWith.value = value;
      expect(JSON.parse((await w.note()).body)).toEqual({ ...value, core: true });
    }
  });

  it("a core entry that throws (a store failure) is a retryable server answer, never a refusal", async () => {
    const w = await world();
    w.answerWith.value = new Error("store unavailable");
    const result = await w.note();
    expect(result.statusCode).toBe(503);
    expect((JSON.parse(result.body) as { error: { code: string } }).error.code).toBe("RUNTIME_UNAVAILABLE");
  });
});

describe("a reply the core is never asked about", () => {

  it("a Slack person who is not linked to a Rovara person adds nothing", async () => {
    const w = await world();
    expect(JSON.parse((await w.note({ userId: STRANGER })).body)).toEqual({ outcome: "refused", notice: "not_allowed", core: true });
    expect(w.calls).toEqual([]);
  });

  it("a thread whose row names another task, a closed thread and a thread with no row are refused before any task is read", async () => {
    for (const guard of [{ taskId: OTHER_TASK }, { closedAt: new Date().toISOString() }, null] as const) {
      const w = await world({ guard });
      const result = await w.note({ mention: true });
      expect(JSON.parse(result.body)).toEqual({ outcome: "refused" });
      expect(w.calls).toEqual([]);
    }
  });

  it("an install with no core entry (or one that takes no thread input) refuses as the old path always did, with nothing written", async () => {
    for (const entry of ["none", "no-thread-input"] as const) {
      const w = await world({ entry });
      expect(JSON.parse((await w.note()).body)).toEqual({ outcome: "refused" });
    }
  });

  it("a task with no core stamp is the old workflow's: the core is not asked, and the old path answers as it did", async () => {
    const w = await world({ stamp: false });
    const result = await w.note({ mention: true });
    expect(w.calls).toEqual([]);
    expect(JSON.parse(result.body)).toEqual({ outcome: "refused" });
  });

  it("a reply from a workspace that is not bound to a project is refused by the old checks, as before", async () => {
    const w = await world();
    const result = await w.note({ thread: { ...thread, channelId: "C0UNBOUND00" } });
    expect(w.calls).toEqual([]);
    expect(JSON.parse(result.body)).toEqual({ outcome: "refused" });
  });
});
