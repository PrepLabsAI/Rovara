import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import {
  changeTaskPeople,
  getTaskPeople,
  takeTaskOwnership,
  taskAccessFence,
  type TaskPeopleDependencies,
  type TaskPersonCheck,
} from "../../packages/broker/src/developer/task-people.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

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

describe("task people", () => {
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
      expect((await errorOf(getTaskPeople(h.deps, OWNER, TASK_ID))).code).toBe("TASK_ACCESS_DENIED");
      expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")).toBeUndefined();
    }
    const unsharedRecord = task({ shared: false, provider: "oidc" });
    delete unsharedRecord.share;
    delete unsharedRecord.slackUserId;
    const unshared = harness({ enabled: true, record: unsharedRecord });
    expect((await errorOf(getTaskPeople(unshared.deps, OWNER, TASK_ID))).code).toBe("TASK_ACCESS_DENIED");
    expect(unshared.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")).toBeUndefined();
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
