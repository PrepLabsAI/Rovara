// L4-U5c: the broker's own check before a Slack workflow start. A thread that already has a guard row (`SHARED_TASK`: the old start writes it, and the core start now writes it too) is "this thread already has a task",
// except when the row is THIS company's own start for THIS request id (Slack's retry of the same event), which goes on to the core, whose idempotency answers the first task. On the old (single workspace) start nothing changes.
// Mutants are listed in briefs/lead4/L4-U5c-MUTANTS-20261118.md with the test that kills each.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { sharedTaskKey } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { issueChannelLinkCode, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/links.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import type { CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";
import { bindSlackChannelInCompany, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, loadSlackBroker } from "../support/slack-broker.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const USER = "U0SHARED00";
const PERSON = "a".repeat(64);
const FIRST_TASK = "11111111-1111-4111-8111-111111111111";
const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1700000000.000001" };

beforeAll(async () => { await loadSlackBroker(); });

/** A company-mode broker (one Slack workspace of company A, one linked person) over a fake core entry that records each start it is asked for. */
async function world() {
  const h = await createDeveloperTaskBroker({ channelMembers: async (r) => ({ ok: true, memberOf: r.channelIds }) });
  // DEC 254zzz80: company A is a NAMED company: its channel binding lives in its own partition.
  bindSlackChannelInCompany(h.db, A);
  const store = new MemoryDocumentStore();
  const members = new Map([[PERSON, A]]);
  const workspaces = { store, getProject: async () => ({ companyId: A }), linkUrl: (code: string) => `https://example.test/review/link/${code}`,
    requireCompany: async (team: string): Promise<string> => { if (team !== SLACK_TEAM) throw Error("private"); return A; }, tokenForEvent: vi.fn(async () => ({ companyId: A, token: "x" })) };
  const code = await issueChannelLinkCode({ store, orgId: A, now: Date.now }, { channel: "slack", tenant: SLACK_TEAM, userId: USER });
  await redeemChannelLinkCode({ store, orgId: A, now: Date.now }, PERSON, code.code);
  const starts: unknown[] = [];
  const entry: CoreTaskEntry = {
    route: vi.fn(async (request: { body?: string }) => { starts.push(JSON.parse(request.body ?? "{}") as unknown); return { statusCode: 200, headers: {}, body: JSON.stringify({ task: { taskId: FIRST_TASK } }) }; }),
    recordThread: vi.fn(async () => true),
  };
  const module = await loadSlackBroker();
  const handler = module.createAwsBrokerHandler({ ...h.brokerInput, store, workspaces, companies: { companyOf: async (id: string) => members.get(id) },
    developer: { ...h.brokerInput.developer!, slackTeamId: "T0OTHER000", coreTasks: entry } } as never);
  const start = (requestId: string, at = thread) => handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: at, userId: USER, instructions: "Add a retry", workflowPath: "QUICK", requestId });
  /** The guard row a core start of company `company` wrote for `requestId` (the shape `slackThreadGuardItem` writes). */
  const guard = (company: string, requestId: string, at = thread) => h.db.set({
    ...sharedTaskKey(at), entityType: "SHARED_TASK", taskId: FIRST_TASK, workspaceId: randomUUID(), ownerKey: taskOwnerKey(PERSON, FIRST_TASK), developerId: PERSON, developerName: "Rovara member", project: "payments",
    mode: "continue", sharedAt: new Date().toISOString(), workflowThread: true, companyId: company, startRequestId: requestId,
  });
  return { ...h, handler, entry, starts, start, guard };
}

describe("a Slack workflow start in a thread that already has a guard row", () => {
  it("a thread with no row starts on the core, once", async () => {
    const w = await world();
    const result = await w.start(randomUUID());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ taskId: FIRST_TASK });
    expect(w.starts).toHaveLength(1);
  });

  it("another request in a thread that has a task is 'already has a task': nothing is asked of the core", async () => {
    const w = await world();
    w.guard(A, randomUUID());
    const result = await w.start(randomUUID());
    expect(result.statusCode).not.toBe(200);
    expect(result.body).toContain("already has a task");
    expect(w.starts).toHaveLength(0);
  });

  it("Slack's retry of the SAME event (this company's row, this request id) goes on to the core, which answers the first task", async () => {
    const w = await world();
    const requestId = randomUUID();
    w.guard(A, requestId);
    const result = await w.start(requestId);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ taskId: FIRST_TASK });
    expect(w.starts).toEqual([expect.objectContaining({ requestId, project: "payments", client: "slack" })]);
  });

  it("another company's row with this request id is not this company's retry: refused, nothing is asked of the core", async () => {
    const w = await world();
    const requestId = randomUUID();
    w.guard(B, requestId);
    const result = await w.start(requestId);
    expect(result.statusCode).not.toBe(200);
    expect(result.body).toContain("already has a task");
    expect(w.starts).toHaveLength(0);
  });

  it("another thread of the same channel is not blocked by the row", async () => {
    const w = await world();
    w.guard(A, randomUUID());
    const result = await w.start(randomUUID(), { ...thread, threadTs: "1700000000.000777" });
    expect(result.statusCode).toBe(200);
    expect(w.starts).toHaveLength(1);
  });

  it("the old start (no company workspaces) keeps its rule: a row means a task, even one that names this request, and the core is never asked", async () => {
    const h = await createDeveloperTaskBroker({ channelMembers: async (r) => ({ ok: true, memberOf: r.channelIds }) });
    const route = vi.fn(async () => undefined);
    const module = await loadSlackBroker();
    const handler = module.createAwsBrokerHandler({ ...h.brokerInput, developer: { ...h.brokerInput.developer!, coreTasks: { route } } } as never);
    const requestId = randomUUID();
    h.db.set({
      ...sharedTaskKey(thread), entityType: "SHARED_TASK", taskId: FIRST_TASK, workspaceId: randomUUID(), ownerKey: taskOwnerKey(PERSON, FIRST_TASK), developerId: PERSON, developerName: "Rovara member", project: "payments",
      mode: "continue", sharedAt: new Date().toISOString(), workflowThread: true, companyId: A, startRequestId: requestId,
    });
    const result = await handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: USER, instructions: "Add a retry", workflowPath: "QUICK", requestId });
    expect(result.statusCode).not.toBe(200);
    expect(result.body).toContain("already has a task");
    expect(route).not.toHaveBeenCalled();
  });
});
