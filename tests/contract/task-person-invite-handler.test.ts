import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TaskPersonInviteExecutionReceipt } from "../../packages/contracts/src/developer.js";
import { createTaskPersonInviteHandler, type TaskPersonInviteHandlerPorts } from "../../packages/broker/src/aws/task-person-invite-handler.js";
import { taskPersonInviteClaimDigest } from "../../packages/broker/src/developer/task-people-effects.js";
import type { TaskPersonCheck } from "../../packages/broker/src/developer/task-people.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const personId = "33333333-3333-4333-8333-333333333333";
const actorId = "a".repeat(64);
const targetId = "b".repeat(64);
const now = Date.parse("2026-10-12T12:00:00.000Z");
const teamId = "T0PEOPLE1";
const channelId = "C0PEOPLE1";
const actorSlackId = "U0OWNER001";
const targetSlackId = "U0TARGET01";

function fixture(overrides: Partial<TaskPersonInviteHandlerPorts> = {}) {
  const deadlineAt = now + 12_000;
  const proposal = {
    pk: `DEVTASK#${taskId}`, sk: `PEOPLE_PROPOSAL#${requestId}`, entityType: "TASK_PEOPLE_PROPOSAL", schemaVersion: 1,
    taskId, requestId, kind: "role", callerDeveloperId: actorId, targetDeveloperId: targetId, personId, role: "owner",
    expectedPeopleRevision: 1, payloadDigest: "d".repeat(64), expiresAt: new Date(now + 60_000).toISOString(),
    invitationTeamId: teamId, invitationChannelId: channelId, invitationSlackUserId: targetSlackId,
    invitationUpdatedAt: new Date(now - 1_000).toISOString(), invitationStatus: "CLAIMED", createdAt: new Date(now - 2_000).toISOString(),
  };
  const task = { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId,
    developerId: actorId, provider: "slack", developerName: "Owner", client: "test", project: "project-alpha",
    title: "Task", workspaceId: "w", ownerKey: actorId, conversationId: "c", startingRevision: 1, charge: { member: { pk: "m", sk: "m" }, organization: { pk: "o", sk: "o" } },
    shared: true, share: { teamId, channelId, threadTs: "1695500000.000081", mode: "continue", sharedReason: "requested", sharedAt: new Date(now - 10_000).toISOString() },
    workflow: { revision: 4, stage: "IMPLEMENT", state: "READY" }, createdAt: new Date(now - 30_000).toISOString(), updatedAt: new Date(now - 1_000).toISOString() };
  const people = { pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false,
    people: [{ developerId: actorId, slackUserId: actorSlackId, name: "Owner", role: "owner" }] };
  const actorReverse = { pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${actorId}`, schemaVersion: 1, personId: "44444444-4444-4444-8444-444444444444", developerId: actorId, createdAt: new Date(now - 20_000).toISOString() };
  const targetReverse = { pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${targetId}`, schemaVersion: 1, personId, developerId: targetId, createdAt: new Date(now - 20_000).toISOString() };
  const actorForward = { pk: `DEVTASK#${taskId}`, sk: `PERSON#${actorReverse.personId}`, schemaVersion: 1, personId: actorReverse.personId, developerId: actorId,
    slackUserId: actorSlackId, method: "slack", issuer: "https://slack.example", subject: actorSlackId, name: "Owner", createdAt: actorReverse.createdAt };
  const targetForward = { pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, developerId: targetId,
    slackUserId: targetSlackId, method: "slack", issuer: "https://slack.example", subject: targetSlackId, name: "Target", createdAt: targetReverse.createdAt };
  const rows = new Map<string, Record<string, unknown>>([
    ["META", task], ["PEOPLE", people], [`PEOPLE_PROPOSAL#${requestId}`, proposal],
    [`PERSON_SUBJECT#${actorId}`, actorReverse], [`PERSON_SUBJECT#${targetId}`, targetReverse],
    [`PERSON#${actorReverse.personId}`, actorForward], [`PERSON#${personId}`, targetForward],
  ]);
  const request = {
    kind: "task-person-invite-claimed" as const, taskId, requestId,
    claimDigest: taskPersonInviteClaimDigest({ taskId, requestId, callerDeveloperId: actorId, targetDeveloperId: targetId, personId,
      role: "owner", expectedPeopleRevision: 1, payloadDigest: proposal.payloadDigest, expiresAt: proposal.expiresAt,
      invitationTeamId: teamId, invitationChannelId: channelId, invitationSlackUserId: targetSlackId, invitationUpdatedAt: proposal.invitationUpdatedAt }),
    admission: { version: 1 as const, id: randomUUID(), deadlineAt, remainingMs: 12_000, authorityRemainingMs: 6_000, slackCallsLimit: 100, stateReadsLimit: 128 },
  };
  let clock = now;
  const receipts = new Map<string, TaskPersonInviteExecutionReceipt>();
  const send = vi.fn(async () => ({ kind: "accepted" as const }));
  const check = (developerId: string): TaskPersonCheck => ({
    subject: { developerId, slackUserId: developerId === actorId ? actorSlackId : targetSlackId },
    identity: { developerId, slackUserId: developerId === actorId ? actorSlackId : targetSlackId, name: "Person", method: "slack", issuer: "https://slack.example", subject: developerId === actorId ? actorSlackId : targetSlackId },
    eligible: true, channelMember: developerId === actorId,
  });
  const ports: TaskPersonInviteHandlerPorts = {
    now: () => clock,
    remainingTimeMs: () => 15_000,
    expectedTeamId: teamId,
    stateTableName: "state",
    async readState({ sortKey }) { return rows.get(sortKey); },
    createPersonChecker: () => async (_task, developerId) => check(developerId),
    async readChannelInfo() { return { isPrivate: false, botIsMember: true, slackCallsUsed: 1 }; },
    async beginReceipt({ receipt, stateFence }) {
      if (JSON.stringify(stateFence.task) !== JSON.stringify(rows.get("META"))
        || JSON.stringify(stateFence.people) !== JSON.stringify(rows.get("PEOPLE"))
        || JSON.stringify(stateFence.proposal) !== JSON.stringify(rows.get(`PEOPLE_PROPOSAL#${requestId}`))) return { kind: "conflict" };
      const key = `${receipt.pk}/${receipt.sk}`;
      const existing = receipts.get(key);
      if (existing !== undefined) return { kind: "existing", receipt: existing };
      receipts.set(key, receipt);
      return { kind: "created" };
    },
    async finishReceipt({ executionReceiptId, claimDigest, status, reason }) {
      const receipt = [...receipts.values()].find((candidate) => candidate.executionReceiptId === executionReceiptId);
      if (receipt === undefined || receipt.claimDigest !== claimDigest || receipt.status !== "STARTED") return false;
      receipts.set(`${receipt.pk}/${receipt.sk}`, { ...receipt, status, updatedAt: new Date(clock).toISOString(), ...(reason === undefined ? {} : { reason }) });
      return true;
    },
    invite: send,
    async targetIsMember() { return { isMember: true, slackCallsUsed: 1 }; },
    configuration: { peopleChangesEnabled: true, publicInvitationsEnabled: true, privateInvitationsEnabled: false,
      publicInviteCapability: true, privateInviteCapability: false },
    ...overrides,
  };
  return { request, rows, receipts, ports, send, setNow(value: number) { clock = value; } };
}

describe("Task Person invite handler", () => {
  it("validates the persisted claim and records one receipt before one bounded invite", async () => {
    const f = fixture();
    const result = await createTaskPersonInviteHandler(f.ports)(f.request);
    expect(result).toMatchObject({ status: "accepted", taskId, requestId, claimDigest: f.request.claimDigest, admissionId: f.request.admission.id });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect([...f.receipts.values()][0]).toMatchObject({ status: "ACCEPTED", attempt: 1, actorDeveloperId: actorId, targetDeveloperId: targetId });
  });

  it("uses a durable receipt CAS to stop duplicate endpoint invocations from posting twice", async () => {
    const f = fixture();
    const handler = createTaskPersonInviteHandler(f.ports);
    const first = await handler(f.request);
    const second = await handler(f.request);
    expect(first.status).toBe("accepted");
    expect(second).toMatchObject({ status: "accepted", executionReceiptId: first.executionReceiptId });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stale claim digest", (f: ReturnType<typeof fixture>) => { f.rows.set(`PEOPLE_PROPOSAL#${requestId}`, { ...f.rows.get(`PEOPLE_PROPOSAL#${requestId}`)!, payloadDigest: "e".repeat(64) }); }],
    ["changed target principal", (f: ReturnType<typeof fixture>) => { f.rows.set(`PERSON#${personId}`, { ...f.rows.get(`PERSON#${personId}`)!, slackUserId: "U0OTHER001" }); }],
    ["disabled public capability", (f: ReturnType<typeof fixture>) => { f.ports.configuration.publicInvitationsEnabled = false; }],
    ["unknown public invite scope", (f: ReturnType<typeof fixture>) => { delete f.ports.configuration.publicInviteCapability; }],
  ])("refuses before POST when %s", async (_label, mutate) => {
    const f = fixture();
    mutate(f);
    const result = await createTaskPersonInviteHandler(f.ports)(f.request);
    expect(result.status).not.toBe("accepted");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("keeps a post-effect throw as UNKNOWN and does not resend a STARTED receipt", async () => {
    const invite = vi.fn(async () => { throw new Error("socket reset after request"); });
    const f = fixture({ invite });
    const handler = createTaskPersonInviteHandler(f.ports);
    expect((await handler(f.request)).status).toBe("unknown");
    expect((await handler(f.request)).status).toBe("unknown");
    expect(invite).toHaveBeenCalledTimes(1);
    expect(["STARTED", "UNKNOWN"]).toContain([...f.receipts.values()][0]?.status);
  });

  it("uses only the separately enabled private-invitation path for a private channel", async () => {
    const f = fixture({ readChannelInfo: async () => ({ isPrivate: true, botIsMember: true, slackCallsUsed: 1 }) });
    const result = await createTaskPersonInviteHandler(f.ports)(f.request);
    expect(result.status).toBe("failed");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("fails closed when the State claim changes between its read and receipt CAS", async () => {
    const f = fixture({
      async readChannelInfo() {
        f.rows.set("PEOPLE", { ...f.rows.get("PEOPLE")!, revision: 2 });
        return { isPrivate: false, botIsMember: true, slackCallsUsed: 1 };
      },
    });
    const result = await createTaskPersonInviteHandler(f.ports)(f.request);
    expect(result.status).toBe("failed");
    expect(f.send).not.toHaveBeenCalled();
  });
});
