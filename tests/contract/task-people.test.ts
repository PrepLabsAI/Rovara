import { createHash, randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import {
  changeTaskPeople,
  getTaskPeople,
  takeTaskOwnership,
  getTaskPeopleCapabilities,
  taskAccessFence,
  type TaskPeopleDependencies,
  type TaskPersonCheck,
} from "../../packages/broker/src/developer/task-people.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { confirmTaskPeopleProposal, getTaskPeopleProposal, proposeTaskPeopleRole, submitSlackTaskPeopleRole } from "../../packages/broker/src/developer/task-people-effects.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const TEAM = "T0PEOPLE1";
const CHANNEL = "C0PEOPLE1";
const START = Date.parse("2026-10-11T10:00:00.000Z");
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const SA = "U0OWNER001";
const SB = "U0MEMBER01";
const SC = "U0MEMBER02";

const actor = (developerId: string, slackUserId: string, name: string): DeveloperCaller => ({
  developerId, slackUserId, name, sessionId: `session-${name}`, amr: "slack",
});

async function peopleBroker() {
  const creator = "U0EREVIEW1";
  const other = "U0EREVIEW2";
  const h = await createDeveloperTaskBroker({
    channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
    developerExtra: {
      taskPeopleConfiguration: { peopleChangesEnabled: true },
      taskPersonProof: async (request) => ({ ok: true, user: { id: request.slackUserId, teamId: SLACK_TEAM, name: request.slackUserId }, memberOf: request.channelIds }),
    },
  });
  const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000081" };
  const start = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: creator,
    instructions: "Local People acceptance fixture", workflowPath: "QUICK", requestId: randomUUID() });
  expect(start.statusCode).toBe(200);
  const taskId = String((JSON.parse(start.body) as { taskId: string }).taskId);
  const stored = h.db.get(`DEVTASK#${taskId}`, "META")!;
  h.db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [
    { developerId: developerIdForSlackUser(creator), slackUserId: creator, name: creator, role: "viewer" },
    { developerId: developerIdForSlackUser(other), slackUserId: other, name: other, role: "owner" },
  ] });
  for (const userId of [creator, other]) {
    const developerId = developerIdForSlackUser(userId);
    const personId = randomUUID();
    const createdAt = new Date().toISOString();
    h.db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, developerId, slackUserId: userId,
      name: userId, method: "slack", issuer: "https://slack.com", subject: userId, createdAt });
    h.db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${developerId}`, schemaVersion: 1, personId, developerId, createdAt });
  }
  return { h, creator, other, thread, taskId, stored };
}

describe("People adapter correction acceptance", () => {
  it("projects the verified task Slack thread as the only add-people destination", async () => {
    const h = harness({ enabled: true, record: task({ share: { teamId: TEAM, channelId: CHANNEL, threadTs: "1695500000.000081", mode: "view",
      sharedReason: "requested", sharedAt: new Date(START).toISOString() } }) });
    await expect(getTaskPeople(h.deps, OWNER, TASK_ID)).resolves.toMatchObject({
      addPeopleUrl: `https://slack.com/archives/${CHANNEL}/p1695500000000081`,
    });
    const withoutThread = harness({ enabled: true });
    const view = await getTaskPeople(withoutThread.deps, OWNER, TASK_ID);
    expect(view).not.toHaveProperty("addPeopleUrl");
  });

  it("keeps a committed proposal pollable and makes an identical proposal replay effect-free", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    const deps = { ...h.deps, issuer: "https://agentx.example.test" };
    const input = { requestId: randomUUID(), expectedPeopleRevision: 1, personId: "22222222-2222-4222-8222-222222222222", role: "viewer" as const };
    await expect(proposeTaskPeopleRole(deps, OWNER, TASK_ID, input)).resolves.toMatchObject({ status: "PENDING" });
    const committed = await confirmTaskPeopleProposal(deps, OWNER, TASK_ID, input.requestId);
    const events = h.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT").length;
    await expect(getTaskPeopleProposal(deps, OWNER, TASK_ID, input.requestId)).resolves.toEqual(committed);
    await expect(proposeTaskPeopleRole(deps, OWNER, TASK_ID, input)).resolves.toEqual(committed);
    expect(h.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT")).toHaveLength(events);
  });

  it("does not invite when the initiating owner is demoted during channel resolution", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    let invited = 0;
    const deps = { ...h.deps, issuer: "https://agentx.example.test",
      resolveTaskPickerPerson: async () => ({ personId: "22222222-2222-4222-8222-222222222222", developerId: B, slackUserId: SB, channelMember: false }),
      taskPeopleChannel: async () => {
        h.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 2, orphaned: false, people: [
          { developerId: A, slackUserId: SA, name: SA, role: "viewer" }, { developerId: C, slackUserId: SC, name: SC, role: "owner" },
        ] });
        return { teamId: TEAM, channelId: CHANNEL };
      },
      inviteTaskPerson: async () => { invited += 1; return "accepted" as const; },
    };
    await expect(submitSlackTaskPeopleRole(deps, OWNER, TASK_ID, { requestId: randomUUID(), expectedPeopleRevision: 1,
      slackUserId: SB, role: "owner", teamId: TEAM, channelId: CHANNEL })).rejects.toBeDefined();
    expect(invited).toBe(0);
    expect(h.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT")).toHaveLength(0);
  });

  it("refuses a directory result whose final profile completes after the admission deadline", async () => {
    let clock = 100_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const directory = slackDirectory({ teamId: TEAM, botToken: async () => "INERT", now: () => clock,
        fetch: async (input: string | URL | Request) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const method = new URL(url).pathname.split("/").at(-1);
          if (method === "conversations.members") return new Response(JSON.stringify({ ok: true, members: [SA], response_metadata: { next_cursor: "" } }));
          clock += 21_000;
          return new Response(JSON.stringify({ ok: true, user: { id: SA, team_id: TEAM, name: SA, is_bot: false, deleted: false, is_stranger: false } }));
        } });
      await expect(directory.taskChannelPeople([CHANNEL])).resolves.toEqual({ ok: false, error: "slack_unavailable" });
    } finally { now.mockRestore(); }
  });

  it("includes the retained task share channel in complete directory admission", async () => {
    const { h, other, taskId, stored } = await peopleBroker();
    const current = { ...stored, share: { ...(stored.share as object), channelId: CHANNEL } };
    h.db.set(current);
    let channels: readonly string[] = [];
    const developer = { ...h.brokerInput.developer, taskChannelPeople: async (request: { channelIds: readonly string[] }) => {
      channels = request.channelIds; return { ok: true as const, users: [] };
    } };
    const caller = actor(developerIdForSlackUser(other), other, other);
    const deps = developerTaskRouteDependencies({ documentClient: h.db, tableName: "state", developer, now: Date.now, tasks: h.actions } as never, caller);
    await getTaskPeople(deps, caller, taskId);
    expect(channels).toContain(CHANNEL);
    expect(channels).toContain(SLACK_CHANNEL);
  });

  it("renders a 99-person complete directory without point-proof reads outside the admitted budget", async () => {
    const { h, creator, other, taskId } = await peopleBroker();
    const users = [creator, other, ...Array.from({ length: 97 }, (_, index) => `U0LIST${String(index).padStart(3, "0")}`)];
    const point = vi.fn(async (request: { slackUserId: string; channelIds: string[] }) => ({ ok: true as const,
      user: { id: request.slackUserId, teamId: SLACK_TEAM, name: request.slackUserId }, memberOf: request.channelIds }));
    const developer = { ...h.brokerInput.developer, taskPersonProof: point,
      taskChannelPeople: async () => ({ ok: true as const, users: users.map((id) => ({ id, teamId: SLACK_TEAM, name: id, memberOf: [SLACK_CHANNEL] })) }) };
    const caller = actor(developerIdForSlackUser(other), other, other);
    const deps = developerTaskRouteDependencies({ documentClient: h.db, tableName: "state", developer, now: Date.now, tasks: h.actions } as never, caller);
    const view = await getTaskPeople(deps, caller, taskId);
    expect(view.people).toHaveLength(99);
    expect(point.mock.calls.length).toBeLessThanOrEqual(100);
  });

  it("uses the authorized actual co-owner for feedback note and retry execution", async () => {
    const { h, other, thread, taskId, stored } = await peopleBroker();
    h.db.set({ ...stored, workflow: { ...(stored.workflow as object), stage: "WAIT_FOR_MERGE", state: "WAITING", feedbackReview: { status: "PENDING" } } });
    expect((await h.handler({ source: "agentx.slack-ingress", action: "task-people-authorize", taskAction: "feedback", taskId, userId: other, thread })).statusCode).toBe(200);
    expect((await h.handler({ source: "agentx.slack-ingress", action: "feedback-note", taskId, userId: other, thread,
      eventId: "EvLocalReview", messageTs: "1695500001.000001", text: "Local fixture note" })).statusCode).toBe(200);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const retry = await h.handler({ source: "agentx.slack-ingress", action: "workflow-feedback-review-retry", taskId, userId: other,
      thread, requestId: randomUUID(), reviewDigest: "a".repeat(64) });
    expect(JSON.parse(retry.body)).toMatchObject({ refused: true });
    expect(logs.mock.calls.flat().join("\n")).toContain('"errorCode":"CONFIG_INVALID"');
    logs.mockRestore();
  });

  it("allows the current co-owner to stop and refuses the demoted creator without a cancellation write", async () => {
    const { h, creator, other, thread, taskId, stored } = await peopleBroker();
    const workspaceId = String(stored.workspaceId);
    const prepare = h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.kind === "prepare")[0]!;
    await h.finish(workspaceId, String(prepare.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
    expect(JSON.parse((await h.handler({ source: "agentx.slack-ingress", action: "stop-task", thread, userId: creator })).body) as unknown).toMatchObject({ outcome: "NOT_OWNER" });
    expect(h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.kind === "cancel")).toHaveLength(0);
    expect(JSON.parse((await h.handler({ source: "agentx.slack-ingress", action: "stop-task", thread, userId: other })).body) as unknown).toMatchObject({ outcome: "CANCEL_REQUESTED" });
    expect(h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.kind === "cancel")).toHaveLength(1);
    expect(taskId).toBe(stored.taskId);
  });

  it("accepts thread input from owners and commenters with the current People fence, while viewers cannot write", async () => {
    const { h, creator, other, thread, taskId } = await peopleBroker();
    const note = (userId: string, messageTs: string) => h.handler({ source: "agentx.slack-ingress", action: "thread-note", taskId, userId, thread,
      messageTs, eventId: `Ev${messageTs}`, text: "Bound task input" });
    await expect(note(creator, "1695500002.000001")).resolves.toMatchObject({ statusCode: 200, body: JSON.stringify({ outcome: "refused" }) });
    await expect(note(other, "1695500002.000002")).resolves.toMatchObject({ statusCode: 200, body: JSON.stringify({ outcome: "captured" }) });
    h.db.set({ ...(h.db.get(`DEVTASK#${taskId}`, "PEOPLE") as Record<string, unknown>), revision: 2, people: [
      { developerId: developerIdForSlackUser(creator), slackUserId: creator, name: creator, role: "owner" },
      { developerId: developerIdForSlackUser(other), slackUserId: other, name: other, role: "commenter" },
    ] });
    await expect(note(other, "1695500002.000003")).resolves.toMatchObject({ statusCode: 200, body: JSON.stringify({ outcome: "captured" }) });
    expect(h.db.get(`DEVTASK#${taskId}`, "NOTE#1695500002.000003")).toMatchObject({ isOwner: false });
  });
});
const OWNER = actor(A, SA, "Avery Owner");
const MEMBER = actor(B, SB, "Bailey Member");
const OTHER = actor(C, SC, "Casey Other");

const task = (overrides: Partial<DeveloperTaskRecord> = {}): DeveloperTaskRecord => ({
  pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID,
  developerId: A, provider: "slack", developerName: OWNER.name, slackUserId: SA,
  client: "slack", project: "payments", title: "Payments", workspaceId: "workspace",
  ownerKey: "f".repeat(64), conversationId: "conversation", startingRevision: 1,
  charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } },
  shared: true, share: { teamId: TEAM, channelId: CHANNEL, mode: "view", sharedReason: "requested", sharedAt: new Date(START).toISOString() },
  createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
  workflow: { revision: 7, stage: "PLAN_REVIEW", state: "WAITING" } as never,
  ...overrides,
});

const identity = (developerId: string, slackUserId: string, name: string, method: "slack" | "oidc" = "slack") => ({
  developerId, slackUserId, name, method,
  issuer: method === "slack" ? "https://slack.com" : "https://identity.example.test",
  subject: method === "slack" ? slackUserId : `subject-${name}`,
});

function harness(options: { enabled?: boolean; creator?: ReturnType<typeof identity>; record?: DeveloperTaskRecord } = {}) {
  const db = new FakeDynamoDb();
  const storedTask = options.record ?? task();
  db.set(storedTask as unknown as Record<string, unknown>);
  const checks = new Map<string, TaskPersonCheck>([
    [A, { subject: { developerId: A, slackUserId: SA }, identity: options.creator ?? identity(A, SA, OWNER.name), eligible: true, channelMember: true }],
    [B, { subject: { developerId: B, slackUserId: SB }, identity: identity(B, SB, MEMBER.name), eligible: true, channelMember: true }],
    [C, { subject: { developerId: C, slackUserId: SC }, identity: identity(C, SC, OTHER.name), eligible: true, channelMember: true }],
  ]);
  const checkTaskPerson = vi.fn(async (_task: DeveloperTaskRecord, developerId: string) => {
    const checked = checks.get(developerId);
    if (checked === undefined) throw new Error("proof unavailable");
    return structuredClone(checked);
  });
  const deps: TaskPeopleDependencies = {
    documentClient: db,
    tableName: "state",
    now: () => START,
    ...(options.enabled === undefined ? {} : { taskPeopleConfiguration: { peopleChangesEnabled: options.enabled } }),
    checkTaskPerson,
  };
  const seedPerson = (developerId: string, personId: string, personIdentity = checks.get(developerId)!.identity) => {
    const createdAt = new Date(START).toISOString();
    db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, ...personIdentity, createdAt });
    db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON_SUBJECT#${developerId}`, schemaVersion: 1, personId, developerId, createdAt });
  };
  return { db, deps, checks, checkTaskPerson, storedTask, seedPerson };
}

const errorOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code?: string }; }
  throw new Error("expected refusal");
};

const isPeopleMutation = (command: unknown) => {
  const candidate = command as { constructor?: { name?: string }; input?: { TransactItems?: Array<{ Update?: { Key?: { sk?: unknown } } }> } };
  return candidate.constructor?.name === "TransactWriteCommand"
    && candidate.input?.TransactItems?.some((item) => item.Update?.Key?.sk === "PEOPLE") === true;
};

describe("task people", () => {
  it("keeps a cold People read visibly unavailable while changes are disabled and writes nothing", async () => {
    const h = harness({ enabled: false });
    const before = structuredClone(h.db.items);
    expect((await errorOf(getTaskPeople(h.deps, OWNER, TASK_ID))).code).toBe("RUNTIME_UNAVAILABLE");
    expect(h.db.items).toEqual(before);
  });

  it("reads current People capabilities without enumerating the registry", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    const send = vi.spyOn(h.db, "send");
    await expect(getTaskPeopleCapabilities(h.deps, OWNER, TASK_ID)).resolves.toEqual({ peopleRevision: 1, canManagePeople: true, canTakeOwnership: false });
    expect(send.mock.calls.some(([command]) => (command as { constructor: { name: string } }).constructor.name === "QueryCommand")).toBe(false);
  });

  it("binds a pending role proposal to the authenticated actor and commits only on confirmation", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    const deps = { ...h.deps, issuer: "https://agentx.example.test" };
    const input = { requestId: "40000000-0000-4000-8000-000000000021", expectedPeopleRevision: 1, personId: "22222222-2222-4222-8222-222222222222", role: "owner" as const };

    await expect(proposeTaskPeopleRole(deps, OWNER, TASK_ID, input)).resolves.toMatchObject({ status: "PENDING", requestId: input.requestId });
    expect((h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE") as { revision: number }).revision).toBe(1);
    expect((await errorOf(getTaskPeopleProposal(deps, MEMBER, TASK_ID, input.requestId))).code).toBe("TASK_ACCESS_DENIED");
    const committed = await confirmTaskPeopleProposal(deps, OWNER, TASK_ID, input.requestId);
    expect(committed).toMatchObject({ status: "COMMITTED", view: { revision: 2 } });
    await expect(getTaskPeopleProposal(deps, OWNER, TASK_ID, input.requestId)).resolves.toEqual(committed);
    await expect(confirmTaskPeopleProposal(deps, OWNER, TASK_ID, input.requestId)).resolves.toEqual(committed);
  });

  it("invites an eligible outside-channel owner, then freshly rechecks both target and initiator before commit", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    let channelMember = false;
    const invite = vi.fn(async () => { channelMember = true; return "accepted" as const; });
    const deps = { ...h.deps, issuer: "https://agentx.example.test", inviteTaskPerson: invite,
      taskPeopleChannel: async () => ({ teamId: TEAM, channelId: CHANNEL }),
      resolveTaskPickerPerson: async () => ({ personId: "22222222-2222-4222-8222-222222222222", developerId: B, slackUserId: SB, channelMember }) };
    h.checks.set(B, { ...h.checks.get(B)!, channelMember: true });

    const result = await submitSlackTaskPeopleRole(deps, OWNER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000031",
      expectedPeopleRevision: 1, slackUserId: SB, role: "owner", teamId: TEAM, channelId: CHANNEL });

    expect(invite).toHaveBeenCalledWith({ teamId: TEAM, channelId: CHANNEL, slackUserId: SB });
    expect(result.status).toBe("COMMITTED");
    if (result.status !== "COMMITTED") throw new Error("accepted invitation did not commit the role");
    expect(result.view.revision).toBe(2);
    expect(result.view.people.some((person) => person.role === "owner")).toBe(true);
  });

  it("never grants on unknown invite or when the initiating owner is revoked during an accepted invite", async () => {
    for (const outcome of ["unknown", "stale"] as const) {
      const h = harness({ enabled: true });
      await getTaskPeople(h.deps, OWNER, TASK_ID);
      h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
      let channelMember = false;
      const invite = vi.fn(async () => {
        if (outcome === "unknown") return "unknown" as const;
        channelMember = true;
        h.checks.set(B, { ...h.checks.get(B)!, channelMember: true });
        h.db.set({ ...(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE") as Record<string, unknown>), revision: 2,
          people: [{ developerId: A, slackUserId: SA, name: OWNER.name, role: "viewer" }, { developerId: C, slackUserId: SC, name: OTHER.name, role: "owner" }], orphaned: false });
        return "accepted" as const;
      });
      const deps = { ...h.deps, issuer: "https://agentx.example.test",
        taskPeopleChannel: async () => ({ teamId: TEAM, channelId: CHANNEL }),
        resolveTaskPickerPerson: async () => ({ personId: "22222222-2222-4222-8222-222222222222", developerId: B, slackUserId: SB, channelMember }),
        inviteTaskPerson: invite };
      const input = { requestId: `40000000-0000-4000-8000-00000000003${outcome === "unknown" ? "2" : "3"}`,
        expectedPeopleRevision: 1, slackUserId: SB, role: "owner" as const, teamId: TEAM, channelId: CHANNEL };
      const error = await errorOf(submitSlackTaskPeopleRole(deps, OWNER, TASK_ID, input));
      expect(error.code).toBe(outcome === "unknown" ? "RUNTIME_UNAVAILABLE" : "CHANGE_STALE");
      await expect(submitSlackTaskPeopleRole(deps, OWNER, TASK_ID, input)).rejects.toBeDefined();
      expect(invite).toHaveBeenCalledOnce();
      expect(h.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT")).toEqual([]);
    }
  });
  it("initializes the exact creator and immutable opaque registry without changing runtime identity", async () => {
    const h = harness({ enabled: true });
    const before = structuredClone(h.db.get(`DEVTASK#${TASK_ID}`, "META"));

    const view = await getTaskPeople(h.deps, OWNER, TASK_ID);

    expect(view).toMatchObject({ revision: 1, orphaned: false, canManage: true, canTakeOwnership: false });
    expect(view.people).toEqual([expect.objectContaining({ name: OWNER.name, role: "owner", effectiveRole: "owner", you: true })]);
    expect(JSON.stringify(view)).not.toContain(A);
    const person = h.db.find((item) => item.pk === `DEVTASK#${TASK_ID}` && String(item.sk).startsWith("PERSON#"));
    expect(person).toHaveLength(1);
    expect(h.db.get(`DEVTASK#${TASK_ID}`, `PERSON_SUBJECT#${A}`)).toMatchObject({ personId: person[0]!.personId, developerId: A });
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "META")).toEqual(before);
    expect(h.db.refusals).toEqual([]);
  });

  it("keeps native and external identities distinct, makes labels unambiguous, and supports an outside-channel Viewer", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    const defaults = await getTaskPeople(h.deps, OWNER, TASK_ID);
    const memberDefault = defaults.people.find((person) => person.name === MEMBER.name);
    expect(memberDefault?.role).toBe("commenter");
    expect(memberDefault?.effectiveRole).toBe("commenter");
    h.checks.set(B, { ...h.checks.get(B)!, channelMember: false });
    const external = identity(C, SB, MEMBER.name, "oidc");
    h.checks.set(C, { subject: { developerId: C, slackUserId: SB }, identity: external, eligible: true, channelMember: true });
    h.seedPerson(C, "33333333-3333-4333-8333-333333333333", external);

    await changeTaskPeople(h.deps, OWNER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000001", expectedPeopleRevision: 1, targetDeveloperId: B, role: "viewer" });
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE_NOTIFY#40000000-0000-4000-8000-000000000001")).toMatchObject({
      entityType: "TASK_PEOPLE_NOTIFICATION", targetDeveloperId: B, slackUserId: SB, role: "viewer", peopleRevision: 2, status: "PENDING", attempts: 0,
    });
    const view = await changeTaskPeople(h.deps, OWNER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000002", expectedPeopleRevision: 2, targetDeveloperId: C, role: "commenter" });

    expect(view.people.filter((person) => person.name.includes(MEMBER.name))).toHaveLength(2);
    expect(new Set(view.people.filter((person) => person.name.includes(MEMBER.name)).map((person) => person.name)).size).toBe(2);
    expect(view.people).toContainEqual(expect.objectContaining({ role: "viewer", effectiveRole: "viewer" }));
    expect(JSON.stringify(view)).not.toContain(B);
    expect(JSON.stringify(view)).not.toContain(C);
  });

  it("keeps denied as a tombstone over channel defaults and refuses unknown target proof", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    const denied = await changeTaskPeople(h.deps, OWNER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000003", expectedPeopleRevision: 1, targetDeveloperId: B, role: "denied" });
    expect(denied.people).toContainEqual(expect.objectContaining({ role: "denied", effectiveRole: null }));

    h.seedPerson(C, "33333333-3333-4333-8333-333333333333");
    h.checks.delete(C);
    expect((await errorOf(changeTaskPeople(h.deps, OWNER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000004", expectedPeopleRevision: 2, targetDeveloperId: C, role: "viewer" }))).code)
      .toBe("TASK_ACCESS_DENIED");
    expect((h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE") as { revision: number }).revision).toBe(2);
  });

  it("keeps enforcement and departure reconciliation active when changes are disabled", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    await changeTaskPeople(h.deps, OWNER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000005", expectedPeopleRevision: 1, targetDeveloperId: B, role: "commenter" });
    h.deps.taskPeopleConfiguration = { peopleChangesEnabled: false };
    h.checks.set(A, { ...h.checks.get(A)!, eligible: false, channelMember: false });

    const view = await getTaskPeople(h.deps, MEMBER, TASK_ID);

    expect(view).toMatchObject({ revision: 3, orphaned: true, canManage: false, canTakeOwnership: false });
    expect(view.people).toContainEqual(expect.objectContaining({ name: OWNER.name, role: "denied", effectiveRole: null }));
    expect((await errorOf(changeTaskPeople(h.deps, MEMBER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000006", expectedPeopleRevision: 3, targetDeveloperId: B, role: "owner" }))).code)
      .toBe("TASK_ACCESS_DENIED");
  });

  it("does not turn unknown owner proof into departure or allowed access", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    await changeTaskPeople(h.deps, OWNER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000019", expectedPeopleRevision: 1, targetDeveloperId: B, role: "commenter" });
    h.checks.delete(A);

    expect((await errorOf(getTaskPeople(h.deps, MEMBER, TASK_ID))).code).toBe("TASK_ACCESS_DENIED");
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")).toMatchObject({ revision: 2, orphaned: false });
    expect((h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE") as { people: unknown[] }).people).toContainEqual(expect.objectContaining({ developerId: A, role: "owner" }));
  });

  it("demotes a departed but otherwise eligible explicit owner before orphaning", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    await changeTaskPeople(h.deps, OWNER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000020", expectedPeopleRevision: 1, targetDeveloperId: B, role: "commenter" });
    h.checks.set(A, { ...h.checks.get(A)!, eligible: true, channelMember: false });

    const view = await getTaskPeople(h.deps, MEMBER, TASK_ID);

    expect(view).toMatchObject({ revision: 3, orphaned: true });
    expect(view.people).toContainEqual(expect.objectContaining({ name: OWNER.name, role: "commenter", effectiveRole: "commenter" }));
  });

  it("reuses a verified external creator registry without aliasing it to native Slack", async () => {
    const creator = identity(A, SA, OWNER.name, "oidc");
    const h = harness({ enabled: true, creator, record: task({ provider: "oidc" }) });
    h.seedPerson(A, "44444444-4444-4444-8444-444444444444", creator);

    const view = await getTaskPeople(h.deps, OWNER, TASK_ID);

    expect(view.people).toEqual([expect.objectContaining({ personId: "44444444-4444-4444-8444-444444444444", role: "owner" })]);
    expect(h.db.find((item) => item.pk === `DEVTASK#${TASK_ID}` && String(item.sk).startsWith("PERSON#"))).toHaveLength(1);
  });

  it("requires explicit enablement for initialization and preserves unshared legacy tasks", async () => {
    for (const enabled of [undefined, false]) {
      const h = harness({ ...(enabled === undefined ? {} : { enabled }) });
      expect((await errorOf(getTaskPeople(h.deps, OWNER, TASK_ID))).code).toBe("RUNTIME_UNAVAILABLE");
      expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")).toBeUndefined();
    }
    const unsharedRecord = task({ shared: false, provider: "oidc" });
    delete unsharedRecord.share;
    delete unsharedRecord.slackUserId;
    const unshared = harness({ enabled: true, record: unsharedRecord });
    expect((await errorOf(getTaskPeople(unshared.deps, OWNER, TASK_ID))).code).toBe("TASK_ACCESS_DENIED");
    expect(unshared.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")).toBeUndefined();
  });

  it("refuses an unauthorized cold read without initializing People or registry rows", async () => {
    const read = harness({ enabled: true });
    read.checks.set(C, { ...read.checks.get(C)!, eligible: false, channelMember: false });
    expect((await errorOf(getTaskPeople(read.deps, OTHER, TASK_ID))).code).toBe("TASK_ACCESS_DENIED");
    expect(read.db.find((item) => item.pk === `DEVTASK#${TASK_ID}` && item.sk !== "META")).toEqual([]);
  });

  it("refuses a non-owner cold change without initializing People or registry rows", async () => {
    const change = harness({ enabled: true });
    expect((await errorOf(changeTaskPeople(change.deps, MEMBER, TASK_ID, {
      requestId: "40000000-0000-4000-8000-000000000021", expectedPeopleRevision: 1, targetDeveloperId: B, role: "viewer",
    }))).code).toBe("TASK_ACCESS_DENIED");
    expect(change.db.find((item) => item.pk === `DEVTASK#${TASK_ID}` && item.sk !== "META")).toEqual([]);
  });

  it("people_revocation_race", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    h.seedPerson(C, "33333333-3333-4333-8333-333333333333");
    await changeTaskPeople(h.deps, OWNER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000007", expectedPeopleRevision: 1, targetDeveloperId: B, role: "owner" });
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE_EVENT#40000000-0000-4000-8000-000000000007")).toMatchObject({
      actorDeveloperId: A, targetDeveloperId: B, beforeRole: "commenter", afterRole: "owner",
    });
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE_REQUEST#40000000-0000-4000-8000-000000000007")).toMatchObject({
      actorDeveloperId: A, kind: "change", outcome: { revision: 2 },
    });
    const request = { requestId: "40000000-0000-4000-8000-000000000008", expectedPeopleRevision: 2, targetDeveloperId: C, role: "viewer" as const };

    const first = await changeTaskPeople(h.deps, OWNER, TASK_ID, request);
    await expect(changeTaskPeople(h.deps, OWNER, TASK_ID, request)).resolves.toEqual(first);
    expect((await errorOf(changeTaskPeople(h.deps, OWNER, TASK_ID, { ...request, role: "commenter" }))).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await errorOf(changeTaskPeople(h.deps, MEMBER, TASK_ID, request))).code).toBe("IDEMPOTENCY_CONFLICT");

    const race = await Promise.allSettled([
      changeTaskPeople(h.deps, OWNER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000009", expectedPeopleRevision: 3, targetDeveloperId: C, role: "commenter" }),
      changeTaskPeople(h.deps, MEMBER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000010", expectedPeopleRevision: 3, targetDeveloperId: C, role: "denied" }),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(h.db.refusals).toEqual([]);

    const current = h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE") as { revision: number };
    await expect(changeTaskPeople(h.deps, OWNER, TASK_ID, {
      requestId: "40000000-0000-4000-8000-000000000011", expectedPeopleRevision: current.revision, targetDeveloperId: B, role: "denied",
    })).resolves.toMatchObject({ orphaned: false });
    const afterB = h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE") as { revision: number };
    expect((await errorOf(changeTaskPeople(h.deps, OWNER, TASK_ID, {
      requestId: "40000000-0000-4000-8000-000000000012", expectedPeopleRevision: afterB.revision, targetDeveloperId: A, role: "denied",
    }))).code).toBe("CONFIG_INVALID");
  });

  it("does not disclose a historical result after the actor loses current access", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    h.seedPerson(C, "33333333-3333-4333-8333-333333333333");
    await changeTaskPeople(h.deps, OWNER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000013", expectedPeopleRevision: 1, targetDeveloperId: B, role: "owner" });
    const historical = { requestId: "40000000-0000-4000-8000-000000000014", expectedPeopleRevision: 2, targetDeveloperId: C, role: "viewer" as const };
    await changeTaskPeople(h.deps, MEMBER, TASK_ID, historical);
    await changeTaskPeople(h.deps, OWNER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000015", expectedPeopleRevision: 3, targetDeveloperId: B, role: "denied" });
    expect((await errorOf(changeTaskPeople(h.deps, MEMBER, TASK_ID, historical))).code).toBe("TASK_ACCESS_DENIED");
  });

  it("refuses an in-flight duplicate outcome after the actor loses current read access", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    h.seedPerson(C, "33333333-3333-4333-8333-333333333333");
    await changeTaskPeople(h.deps, OWNER, TASK_ID, {
      requestId: "40000000-0000-4000-8000-000000000022", expectedPeopleRevision: 1, targetDeveloperId: B, role: "owner",
    });
    const request = {
      requestId: "40000000-0000-4000-8000-000000000023", expectedPeopleRevision: 2, targetDeveloperId: C, role: "viewer" as const,
    };
    let raced = false;
    h.deps.documentClient = {
      send: async (command: unknown) => {
        if (!raced && isPeopleMutation(command)) {
          raced = true;
          await h.db.send(command as never);
          const people = h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE") as { revision: number; people: Array<{ developerId: string; role: string }> };
          h.db.set({ ...people, pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", revision: people.revision + 1,
            people: people.people.map((person) => person.developerId === B ? { ...person, role: "denied" } : person) });
        }
        return h.db.send(command as never);
      },
    };

    expect((await errorOf(changeTaskPeople(h.deps, MEMBER, TASK_ID, request))).code).toBe("TASK_ACCESS_DENIED");
    expect(h.db.find((item) => item.sk === `PEOPLE_EVENT#${request.requestId}`)).toHaveLength(1);
    expect(h.db.find((item) => item.sk === `PEOPLE_REQUEST#${request.requestId}`)).toHaveLength(1);
  });

  it("fences role changes and takeover against a terminal task transition", async () => {
    const change = harness({ enabled: true });
    await getTaskPeople(change.deps, OWNER, TASK_ID);
    change.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    let closed = false;
    change.deps.documentClient = {
      send: async (command: unknown) => {
        if (!closed && isPeopleMutation(command)) {
          closed = true;
          change.db.set({ ...change.db.get(`DEVTASK#${TASK_ID}`, "META")!, closedAt: new Date(START + 1_000).toISOString() });
        }
        return change.db.send(command as never);
      },
    };
    const changeRequest = "40000000-0000-4000-8000-000000000024";
    expect((await errorOf(changeTaskPeople(change.deps, OWNER, TASK_ID, {
      requestId: changeRequest, expectedPeopleRevision: 1, targetDeveloperId: B, role: "viewer",
    }))).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(change.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")).toMatchObject({ revision: 1 });
    expect(change.db.get(`DEVTASK#${TASK_ID}`, `PEOPLE_EVENT#${changeRequest}`)).toBeUndefined();
    expect(change.db.get(`DEVTASK#${TASK_ID}`, `PEOPLE_REQUEST#${changeRequest}`)).toBeUndefined();

    const takeover = harness({ enabled: true });
    await getTaskPeople(takeover.deps, OWNER, TASK_ID);
    takeover.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    await changeTaskPeople(takeover.deps, OWNER, TASK_ID, {
      requestId: "40000000-0000-4000-8000-000000000025", expectedPeopleRevision: 1, targetDeveloperId: B, role: "commenter",
    });
    takeover.checks.set(A, { ...takeover.checks.get(A)!, eligible: false, channelMember: false });
    const orphaned = await getTaskPeople(takeover.deps, MEMBER, TASK_ID);
    let terminal = false;
    takeover.deps.documentClient = {
      send: async (command: unknown) => {
        if (!terminal && isPeopleMutation(command)) {
          terminal = true;
          const meta = takeover.db.get(`DEVTASK#${TASK_ID}`, "META")!;
          takeover.db.set({ ...meta, workflow: { ...(meta.workflow as Record<string, unknown>), stage: "CLOSED" } });
        }
        return takeover.db.send(command as never);
      },
    };
    const takeoverRequest = "40000000-0000-4000-8000-000000000026";
    expect((await errorOf(takeTaskOwnership(takeover.deps, MEMBER, TASK_ID, {
      requestId: takeoverRequest, expectedPeopleRevision: orphaned.revision,
    }))).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(takeover.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")).toMatchObject({ revision: orphaned.revision, orphaned: true });
    expect(takeover.db.get(`DEVTASK#${TASK_ID}`, `PEOPLE_EVENT#${takeoverRequest}`)).toBeUndefined();
    expect(takeover.db.get(`DEVTASK#${TASK_ID}`, `PEOPLE_REQUEST#${takeoverRequest}`)).toBeUndefined();
  });

  it("external owner loss becomes orphaned and takeover only changes the role", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    await changeTaskPeople(h.deps, OWNER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000016", expectedPeopleRevision: 1, targetDeveloperId: B, role: "commenter" });
    h.checks.set(A, { ...h.checks.get(A)!, eligible: false, channelMember: false });
    const orphaned = await getTaskPeople(h.deps, MEMBER, TASK_ID);
    const beforeTask = structuredClone(h.db.get(`DEVTASK#${TASK_ID}`, "META"));

    const taken = await takeTaskOwnership(h.deps, MEMBER, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000017", expectedPeopleRevision: orphaned.revision });

    expect(taken).toMatchObject({ orphaned: false, canTakeOwnership: false });
    expect(taken.people).toContainEqual(expect.objectContaining({ name: MEMBER.name, role: "owner", effectiveRole: "owner", you: true }));
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "META")).toEqual(beforeTask);
  });

  it("initializes_people_against_inflight_legacy_action", async () => {
    const legacy = (h: ReturnType<typeof harness>, marker: string) => h.db.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: "state", Key: { pk: `DEVTASK#${TASK_ID}`, sk: "META" }, UpdateExpression: "SET legacyMarker = :marker", ConditionExpression: "workflow.revision = :revision", ExpressionAttributeValues: { ":marker": marker, ":revision": 7 } } },
      taskAccessFence("state", TASK_ID),
    ] }));

    const legacyFirst = harness({ enabled: true });
    let initStarted: (() => void) | undefined;
    let releaseInit: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { initStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseInit = resolve; });
    legacyFirst.deps.documentClient = {
      send: async (command: unknown) => {
        const candidate = command as { constructor?: { name?: string }; input?: { TransactItems?: Array<{ Put?: { Item?: { sk?: unknown } } }> } };
        if (candidate.constructor?.name === "TransactWriteCommand" && candidate.input?.TransactItems?.some((item) => item.Put?.Item?.sk === "PEOPLE")) {
          initStarted!();
          await gate;
        }
        return legacyFirst.db.send(command as never);
      },
    };
    const initializing = getTaskPeople(legacyFirst.deps, OWNER, TASK_ID);
    await started;
    await legacy(legacyFirst, "before");
    releaseInit!();
    await initializing;
    expect(legacyFirst.db.get(`DEVTASK#${TASK_ID}`, "META")).toMatchObject({ legacyMarker: "before" });

    const initFirst = harness({ enabled: true });
    await getTaskPeople(initFirst.deps, OWNER, TASK_ID);
    await expect(legacy(initFirst, "after")).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(initFirst.db.get(`DEVTASK#${TASK_ID}`, "META")).not.toHaveProperty("legacyMarker");
  });

  it("preflights an oversized mutation without a partial transaction", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, OWNER, TASK_ID);
    h.seedPerson(B, "22222222-2222-4222-8222-222222222222");
    const large = Array.from({ length: 4_200 }, (_, index) => ({
      developerId: createHash("sha256").update(String(index)).digest("hex"),
      slackUserId: `U${String(index).padStart(8, "0")}`,
      name: `Person ${String(index).padStart(8, "0")} ${"x".repeat(60)}`,
      role: "denied",
    }));
    h.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [
      { developerId: A, slackUserId: SA, name: OWNER.name, role: "owner" }, ...large,
    ] });
    const before = structuredClone(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE"));
    const transactions = h.db.commandNames().filter((name) => name === "TransactWriteCommand").length;

    expect((await errorOf(changeTaskPeople(h.deps, OWNER, TASK_ID, {
      requestId: "40000000-0000-4000-8000-000000000018", expectedPeopleRevision: 1, targetDeveloperId: B, role: "viewer",
    }))).code).toBe("CONFIG_INVALID");
    expect(h.db.commandNames().filter((name) => name === "TransactWriteCommand")).toHaveLength(transactions);
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")).toEqual(before);
  });

  it("returns the exact enabled and legacy transaction fences", () => {
    expect(taskAccessFence("state", TASK_ID)).toEqual({ ConditionCheck: {
      TableName: "state", Key: { pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE" }, ConditionExpression: "attribute_not_exists(pk)",
    } });
    expect(taskAccessFence("state", TASK_ID, 9)).toEqual({ ConditionCheck: {
      TableName: "state", Key: { pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE" }, ConditionExpression: "#revision = :revision",
      ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": 9 },
    } });
    expect(taskOwnerKey(A, TASK_ID)).toMatch(/^[a-f0-9]{64}$/);
  });
});
