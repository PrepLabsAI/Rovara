// Web task channel C3 (plan 3 item 5, plan 4.2 "PEOPLE without a Slack share" and "Dispatch"; decisions D1, D2, D3): a task with no Slack share
// gets a People list once its creator passes their own proof path, and its owners count for dispatch while they are eligible and present.
// A web owner who loses company membership or the project grant is demoted by reconcile, and dispatch goes OWNERLESS. A web identity holds only a
// role someone gave it: being a member with a grant alone never makes anyone an implicit commenter.
import { describe, expect, it, vi } from "vitest";
import { SLACK_OIDC_ISSUER, type TaskPersonProofRequest, type TaskPersonProofResponse } from "@agentx/contracts";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES, withTaskPersonMembershipRead, type TaskPersonRuntimePorts } from "../../packages/broker/src/aws/task-person-runtime.js";
import { checkTaskPersonIdentity, type ProjectAccessSubject, type TaskPersonIdentityDependencies } from "../../packages/broker/src/developer/task-person-identity.js";
import {
  changeTaskPeople, getTaskPeople, getTaskPeopleCapabilities, resolveTaskDispatchPeople, resolveTaskPeopleAccess, takeTaskOwnership, type TaskPeopleDependencies,
} from "../../packages/broker/src/developer/task-people.js";
import { taskOwnerKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import type { DeveloperRecord } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { T0, TEAM } from "../support/developer-fakes.js";

const TASK_A = "44444444-4444-4444-8444-444444444444";
const CHANNEL = "C0WEBTASK1";
const SAM = "U0SAMSLACK";
const SAM_ID = developerIdForSlackUser(SAM);
const GH_ISSUER = "https://github.com";
const GALE_ID = ownerKeyForSubject(GH_ISSUER, "gh-1234");
const CLOUD_ISSUER = "https://cloud.example.test";
const WREN_ID = ownerKeyForSubject(CLOUD_ISSUER, "wren-7");
const P_SAM = "55555555-5555-4555-8555-555555555555";
const P_GALE = "66666666-6666-4666-8666-666666666666";
const P_WREN = "99999999-9999-4999-8999-999999999999";
const CREATED = new Date(T0 - 60_000).toISOString();
const companyId = (letter: string) => `org_${letter.repeat(20)}`;
const COMPANY_A = companyId("a");
const COMPANY_B = companyId("b");

/** A task Gale started with GitHub sign-in on the web: no Slack share, no Slack id. */
const webTask = (overrides: Record<string, unknown> = {}): DeveloperTaskRecord => {
  const record = {
    pk: `DEVTASK#${TASK_A}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_A,
    developerId: GALE_ID, provider: "github", developerName: "Gale GitHub",
    client: "web", project: "payments", title: "Payments", workspaceId: `workspace-${TASK_A}`,
    ownerKey: "f".repeat(64), conversationId: "conversation", startingRevision: 1,
    charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } },
    shared: false, createdAt: CREATED, updatedAt: CREATED, companyId: COMPANY_A,
    workflow: { revision: 7, stage: "PLAN_REVIEW", state: "WAITING" },
    ...overrides,
  };
  return record as unknown as DeveloperTaskRecord;
};
/** A task Sam started in Slack but never shared to a channel. */
const slackUnsharedTask = () => webTask({ developerId: SAM_ID, provider: "slack", developerName: "Sam Slack", slackUserId: SAM, client: "slack" });

const record = (developerId: string, provider: "github" | "cloud", issuer: string, subject: string, name: string, overrides: Partial<DeveloperRecord> = {}): DeveloperRecord => ({
  developerId, provider, issuer, subject, displayName: name, firstSignInAt: CREATED, lastSignInAt: CREATED, revoked: false, ...overrides,
});
const personRow = (personId: string, fields: Record<string, unknown>) => ({ pk: `DEVTASK#${TASK_A}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, createdAt: CREATED, ...fields });
const subjectRow = (personId: string, developerId: string) => ({ pk: `DEVTASK#${TASK_A}`, sk: `PERSON_SUBJECT#${developerId}`, schemaVersion: 1, personId, developerId, createdAt: CREATED });
const galeRow = () => personRow(P_GALE, { developerId: GALE_ID, name: "Gale GitHub", method: "github", issuer: GH_ISSUER, subject: "gh-1234" });
const wrenRow = () => personRow(P_WREN, { developerId: WREN_ID, name: "Wren Cloud", method: "cloud", issuer: CLOUD_ISSUER, subject: "wren-7" });
const samRow = () => personRow(P_SAM, { developerId: SAM_ID, slackUserId: SAM, name: "Sam Slack", method: "slack", issuer: SLACK_OIDC_ISSUER, subject: SAM });
const peopleRow = (people: unknown[], revision = 3, orphaned = false) => ({ pk: `DEVTASK#${TASK_A}`, sk: "PEOPLE", schemaVersion: 1, revision, orphaned, people });
const GALE = (role: string) => ({ developerId: GALE_ID, name: "Gale GitHub", role, method: "github" });
const WREN = (role: string) => ({ developerId: WREN_ID, name: "Wren Cloud", role, method: "cloud" });
const SAM_ENTRY = (role: string) => ({ developerId: SAM_ID, slackUserId: SAM, name: "Sam Slack", role });

const caller = (developerId: string, name: string, amr: DeveloperCaller["amr"] = "github", slackUserId?: string): DeveloperCaller => ({
  developerId, name, sessionId: `session-${name}`, amr, ...(slackUserId === undefined ? {} : { slackUserId }),
});
const GALE_CALLER = caller(GALE_ID, "Gale GitHub");
const WREN_CALLER = caller(WREN_ID, "Wren Cloud", "cloud");

const errorOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code?: string }; }
  throw new Error("expected refusal");
};

interface World {
  task?: DeveloperTaskRecord;
  memberships?: Record<string, string | undefined>;
  grants?: Record<string, boolean>;
  revoked?: string[];
  /** Slack user ids the fresh Slack proof says are not in the task's channel. */
  outOfChannel?: string[];
}

function harness(world: World = {}) {
  const db = new FakeDynamoDb();
  db.set((world.task ?? webTask()) as unknown as Record<string, unknown>);
  const sent: unknown[] = [];
  const documentClient = { send: async (command: unknown) => { sent.push(command); return db.send(command as never); } };
  const records: Record<string, DeveloperRecord> = {
    [GALE_ID]: record(GALE_ID, "github", GH_ISSUER, "gh-1234", "Gale GitHub", { revoked: world.revoked?.includes(GALE_ID) ?? false }),
    [WREN_ID]: record(WREN_ID, "cloud", CLOUD_ISSUER, "wren-7", "Wren Cloud", { revoked: world.revoked?.includes(WREN_ID) ?? false }),
  };
  const memberships: Record<string, string | undefined> = { [GALE_ID]: COMPANY_A, [WREN_ID]: COMPANY_A, ...(world.memberships ?? {}) };
  const grants: Record<string, boolean> = { [GALE_ID]: true, [WREN_ID]: true, ...(world.grants ?? {}) };
  const proof = vi.fn(async (request: TaskPersonProofRequest): Promise<TaskPersonProofResponse> => ({
    ok: true, user: { id: request.slackUserId, teamId: TEAM, name: "Sam Slack" }, memberOf: world.outOfChannel?.includes(request.slackUserId) === true ? [] : [CHANNEL],
  }));
  const identityDeps: TaskPersonIdentityDependencies = {
    documentClient, tableName: "state", slackTeamId: TEAM, now: () => T0, uuid: () => P_SAM,
    taskPersonProof: proof,
    developerRecord: async (developerId) => records[developerId],
    projectChannelIds: async () => [CHANNEL],
    targetProjectAccess: async (subject: ProjectAccessSubject, project: string, memberOf: readonly string[]) => { void [subject, project, memberOf]; },
    companyMembership: async (developerId) => {
      const found = memberships[developerId];
      return found === undefined ? undefined : { companyId: found };
    },
    projectGrant: async (developerId) => grants[developerId] ?? false,
  };
  const peopleDeps: TaskPeopleDependencies = {
    documentClient, tableName: "state", now: () => T0, taskPeopleConfiguration: { peopleChangesEnabled: true },
    checkTaskPerson: (task, developerId) => checkTaskPersonIdentity(identityDeps, task, developerId),
  };
  const seed = (...rows: Array<Record<string, unknown>>) => { for (const row of rows) db.set(row); };
  const people = () => db.get(`DEVTASK#${TASK_A}`, "PEOPLE");
  return { db, sent, proof, identityDeps, peopleDeps, seed, people };
}

/** Gale (web owner) and Wren (web commenter) on Gale's unshared web task. */
function webPeople(world: World = {}, galeRole = "owner", wrenRole = "commenter", orphaned = false) {
  const h = harness(world);
  h.seed(galeRow(), subjectRow(P_GALE, GALE_ID), wrenRow(), subjectRow(P_WREN, WREN_ID), peopleRow([GALE(galeRole), WREN(wrenRole)], 3, orphaned));
  return h;
}

describe("PEOPLE for a task with no Slack share", () => {
  it("makes the People list for a web creator who passes the web proof, with no Slack call and no add-in-Slack link", async () => {
    const h = harness();
    const view = await getTaskPeople(h.peopleDeps, GALE_CALLER, TASK_A);
    expect(view).toMatchObject({ revision: 1, orphaned: false, canManage: true, canTakeOwnership: false, people: [{ name: "Gale GitHub", role: "owner", you: true, effectiveRole: "owner" }] });
    expect(view).not.toHaveProperty("addPeopleUrl");
    expect(h.people()).toMatchObject({ revision: 1, orphaned: false, people: [GALE("owner")] });
    expect(h.db.get(`DEVTASK#${TASK_A}`, `PERSON_SUBJECT#${GALE_ID}`)).toMatchObject({ developerId: GALE_ID });
    expect(h.proof).not.toHaveBeenCalled();
  });

  it("writes no list when the task is shared while its creator is being proved (the write's condition fails)", async () => {
    const h = harness();
    const check = h.peopleDeps.checkTaskPerson!;
    h.peopleDeps.checkTaskPerson = async (task, developerId) => {
      const result = await check(task, developerId);
      h.db.set({ ...(webTask() as unknown as Record<string, unknown>), shared: true, share: { teamId: TEAM, channelId: CHANNEL, threadTs: "1695500000.000081", mode: "view", sharedReason: "requested", sharedAt: CREATED } });
      return result;
    };
    await expect(getTaskPeople(h.peopleDeps, GALE_CALLER, TASK_A)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(h.people()).toBeUndefined();
  });

  it("answers a missing task, a shared task and a refused person with the same words when there are no Slack display reads", async () => {
    const missing = harness();
    const shared = harness({ task: webTask({ shared: true, share: { teamId: TEAM, channelId: CHANNEL, threadTs: "1695500000.000081", mode: "view", sharedReason: "requested", sharedAt: CREATED } }) });
    const refused = harness({ grants: { [GALE_ID]: false } });
    const answers = await Promise.all([
      errorOf(getTaskPeople(missing.peopleDeps, GALE_CALLER, "55555555-0000-4000-8000-000000000000")),
      errorOf(getTaskPeople(shared.peopleDeps, GALE_CALLER, TASK_A)),
      errorOf(getTaskPeople(refused.peopleDeps, GALE_CALLER, TASK_A)),
    ]);
    expect(new Set(answers.map((error) => `${error.code}|${error.message}`)).size).toBe(1);
    expect(answers[0].code).toBe("RUNTIME_UNAVAILABLE");
  });

  it("makes an unshared task's list only while the task is still unshared", async () => {
    const h = harness();
    await getTaskPeople(h.peopleDeps, GALE_CALLER, TASK_A);
    const write = h.sent.find((command): command is TransactWriteCommand => command instanceof TransactWriteCommand);
    const check = write?.input.TransactItems?.find((item) => item.ConditionCheck !== undefined)?.ConditionCheck;
    expect(check?.ConditionExpression).toContain("attribute_not_exists(#share)");
    expect(check?.ExpressionAttributeNames).toMatchObject({ "#share": "share" });
  });

  it.each([
    ["is not a member of the task's company", { memberships: { [GALE_ID]: COMPANY_B } }],
    ["has no grant on the project", { grants: { [GALE_ID]: false } }],
    ["has a revoked sign-in", { revoked: [GALE_ID] }],
  ])("writes no People list when the web creator %s", async (_label, world) => {
    const h = harness(world);
    expect((await errorOf(getTaskPeople(h.peopleDeps, GALE_CALLER, TASK_A))).code).toBe("RUNTIME_UNAVAILABLE");
    expect(h.people()).toBeUndefined();
    expect(h.db.find((item) => String(item.sk).startsWith("PERSON"))).toEqual([]);
  });

  it("makes the list for a Slack creator of an unshared task through the Slack proof, exactly as a shared one", async () => {
    const h = harness({ task: slackUnsharedTask() });
    await getTaskPeople(h.peopleDeps, caller(SAM_ID, "Sam Slack", "slack", SAM), TASK_A);
    expect(h.people()).toMatchObject({ revision: 1, people: [SAM_ENTRY("owner")] });
    expect(h.proof).toHaveBeenCalled();
  });

  it("still needs the Slack display reads for a Slack-shared task (unchanged)", async () => {
    const h = harness({ task: webTask({ shared: true, share: { teamId: TEAM, channelId: CHANNEL, threadTs: "1695500000.000081", mode: "view", sharedReason: "requested", sharedAt: CREATED } }) });
    expect((await errorOf(getTaskPeople(h.peopleDeps, GALE_CALLER, TASK_A))).code).toBe("RUNTIME_UNAVAILABLE");
    expect(h.people()).toBeUndefined();
  });
});

describe("present web owners and the People lifecycle on an unshared task", () => {
  it("counts every present web owner for dispatch", async () => {
    const h = webPeople({}, "owner", "owner");
    await expect(resolveTaskDispatchPeople(h.peopleDeps, webTask())).resolves.toStrictEqual({
      peopleRevision: 3, ownerActorIds: [taskOwnerKey(GALE_ID, TASK_A), taskOwnerKey(WREN_ID, TASK_A)], status: "ALLOWED",
    });
    expect(h.proof).not.toHaveBeenCalled();
  });

  it.each([
    ["loses company membership", { memberships: { [GALE_ID]: undefined } }],
    ["moves to another company", { memberships: { [GALE_ID]: COMPANY_B } }],
    ["loses the project grant", { grants: { [GALE_ID]: false } }],
  ])("a sole web owner who %s makes dispatch OWNERLESS, and reconcile demotes them", async (_label, world) => {
    const h = webPeople(world);
    await expect(resolveTaskDispatchPeople(h.peopleDeps, webTask())).resolves.toStrictEqual({ peopleRevision: 3, ownerActorIds: [], status: "OWNERLESS" });
    await expect(resolveTaskPeopleAccess(h.peopleDeps, webTask(), WREN_ID)).resolves.toMatchObject({ role: "commenter", orphaned: true, peopleRevision: 4, canTakeOwnership: true });
    expect(h.people()).toMatchObject({ revision: 4, orphaned: true, people: [GALE("denied"), WREN("commenter")] });
  });

  it("lets a present web commenter take ownership of the orphaned task (canTakeOwnership uses present)", async () => {
    const h = webPeople({}, "denied", "commenter", true);
    await expect(getTaskPeopleCapabilities(h.peopleDeps, WREN_CALLER, TASK_A)).resolves.toEqual({ peopleRevision: 3, canManagePeople: false, canTakeOwnership: true });
    await takeTaskOwnership(h.peopleDeps, WREN_CALLER, TASK_A, { requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expectedPeopleRevision: 3 });
    expect(h.people()).toMatchObject({ orphaned: false, people: [GALE("denied"), WREN("owner")] });
  });

  it("never lets a web commenter without a grant take ownership", async () => {
    const h = webPeople({ grants: { [WREN_ID]: false } }, "denied", "commenter", true);
    expect((await errorOf(getTaskPeopleCapabilities(h.peopleDeps, WREN_CALLER, TASK_A))).code).toBe("TASK_ACCESS_DENIED");
    expect((await errorOf(takeTaskOwnership(h.peopleDeps, WREN_CALLER, TASK_A, { requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expectedPeopleRevision: 3 }))).code).toBe("TASK_ACCESS_DENIED");
  });

  it("mixed unshared task: a Slack owner (present, no channel needed) and a web commenter each keep their role", async () => {
    const h = harness({ task: slackUnsharedTask() });
    h.seed(samRow(), subjectRow(P_SAM, SAM_ID), galeRow(), subjectRow(P_GALE, GALE_ID), peopleRow([SAM_ENTRY("owner"), GALE("commenter")]));
    await expect(resolveTaskPeopleAccess(h.peopleDeps, slackUnsharedTask(), SAM_ID)).resolves.toMatchObject({ role: "owner", peopleRevision: 3 });
    await expect(resolveTaskPeopleAccess(h.peopleDeps, slackUnsharedTask(), GALE_ID)).resolves.toMatchObject({ role: "commenter", peopleRevision: 3 });
    await expect(resolveTaskDispatchPeople(h.peopleDeps, slackUnsharedTask())).resolves.toMatchObject({ ownerActorIds: [taskOwnerKey(SAM_ID, TASK_A)], status: "ALLOWED" });
    expect(h.proof.mock.calls.every(([request]) => request.slackUserId === SAM)).toBe(true);
  });
});

describe("a web identity holds only a role someone gave it", () => {
  it("gives a registered web person with no PEOPLE entry no access, however present", async () => {
    const h = harness();
    h.seed(galeRow(), subjectRow(P_GALE, GALE_ID), wrenRow(), subjectRow(P_WREN, WREN_ID), peopleRow([GALE("owner")]));
    expect((await errorOf(resolveTaskPeopleAccess(h.peopleDeps, webTask(), WREN_ID))).code).toBe("TASK_ACCESS_DENIED");
    expect((await errorOf(getTaskPeople(h.peopleDeps, WREN_CALLER, TASK_A))).code).toBe("RUNTIME_UNAVAILABLE");
    // The owner's view lists only people with a role.
    const view = await getTaskPeople(h.peopleDeps, GALE_CALLER, TASK_A);
    expect(view.people.map((person) => person.name)).toEqual(["Gale GitHub"]);
  });
});

describe("no channel on an unshared task: nobody is present without a role", () => {
  it("gives a present web person with no PEOPLE entry no access on a Slack-shared task either (no implicit commenter for web)", async () => {
    const shared = webTask({ shared: true, share: { teamId: TEAM, channelId: CHANNEL, threadTs: "1695500000.000081", mode: "view", sharedReason: "requested", sharedAt: CREATED } });
    const h = harness({ task: shared });
    h.seed(galeRow(), subjectRow(P_GALE, GALE_ID), wrenRow(), subjectRow(P_WREN, WREN_ID), peopleRow([GALE("owner")]));
    expect((await errorOf(resolveTaskPeopleAccess(h.peopleDeps, shared, WREN_ID))).code).toBe("TASK_ACCESS_DENIED");
  });

  it("gives an eligible Slack person with no PEOPLE entry no access on an unshared task (no implicit commenter without a channel)", async () => {
    const h = harness({ task: slackUnsharedTask() });
    const BAY = "U0BAYSLACK";
    const bayId = developerIdForSlackUser(BAY);
    h.seed(samRow(), subjectRow(P_SAM, SAM_ID), personRow("88888888-8888-4888-8888-888888888888", { developerId: bayId, slackUserId: BAY, name: "Bay Slack", method: "slack", issuer: SLACK_OIDC_ISSUER, subject: BAY }),
      subjectRow("88888888-8888-4888-8888-888888888888", bayId), peopleRow([SAM_ENTRY("owner")]));
    expect((await errorOf(resolveTaskPeopleAccess(h.peopleDeps, slackUnsharedTask(), bayId))).code).toBe("TASK_ACCESS_DENIED");
  });

  it("lets only the creator start an unshared task's People list: another present person's read writes nothing", async () => {
    const h = harness();
    h.seed(wrenRow(), subjectRow(P_WREN, WREN_ID));
    expect((await errorOf(getTaskPeople(h.peopleDeps, WREN_CALLER, TASK_A))).code).toBe("RUNTIME_UNAVAILABLE");
    expect(h.people()).toBeUndefined();
  });
});

describe("Slack identities on a Slack-shared task keep needing the channel to own (D2), now through taskPersonPresent", () => {
  const SHARE = { teamId: TEAM, channelId: CHANNEL, threadTs: "1695500000.000081", mode: "view", sharedReason: "requested", sharedAt: CREATED };
  const sharedSlackTask = () => webTask({ developerId: SAM_ID, provider: "slack", developerName: "Sam Slack", slackUserId: SAM, client: "slack", shared: true, share: SHARE });
  const BAY = "U0BAYSLACK";
  const BAY_ID = developerIdForSlackUser(BAY);
  const P_BAY = "88888888-8888-4888-8888-888888888888";
  const bayRow = () => personRow(P_BAY, { developerId: BAY_ID, slackUserId: BAY, name: "Bay Slack", method: "slack", issuer: SLACK_OIDC_ISSUER, subject: BAY });
  const BAY_ENTRY = (role: string) => ({ developerId: BAY_ID, slackUserId: BAY, name: "Bay Slack", role });

  it("never counts a Slack owner who left the channel for dispatch", async () => {
    const h = harness({ task: sharedSlackTask(), outOfChannel: [SAM] });
    h.seed(samRow(), subjectRow(P_SAM, SAM_ID), peopleRow([SAM_ENTRY("owner")]));
    await expect(resolveTaskDispatchPeople(h.peopleDeps, sharedSlackTask())).resolves.toStrictEqual({ peopleRevision: 3, ownerActorIds: [], status: "OWNERLESS" });
  });

  /** Display reads for a Slack-shared task: an admission that never runs out and an empty directory. */
  const withDisplay = (deps: TaskPeopleDependencies): TaskPeopleDependencies => ({
    ...deps,
    createTaskPeopleDisplayAdmission: () => ({
      assertOpen: () => undefined, admitIdentity: () => undefined, noteNativeIdentity: () => undefined, close: () => undefined,
      proof: async () => { throw new Error("not used"); }, directory: async () => { throw new Error("not used"); },
    }),
    listTaskPeople: async () => [],
  });

  it("never lets another channel member start the People list while the creator is out of the channel", async () => {
    const h = harness({ task: sharedSlackTask(), outOfChannel: [SAM] });
    h.seed(samRow(), subjectRow(P_SAM, SAM_ID), bayRow(), subjectRow(P_BAY, BAY_ID));
    expect((await errorOf(getTaskPeople(withDisplay(h.peopleDeps), caller(BAY_ID, "Bay Slack", "slack", BAY), TASK_A))).code).toBe("TASK_ACCESS_DENIED");
    expect(h.people()).toBeUndefined();
  });

  it("never lets a person outside the channel start the People list, even with the creator present", async () => {
    const h = harness({ task: sharedSlackTask(), outOfChannel: [BAY] });
    h.seed(samRow(), subjectRow(P_SAM, SAM_ID), bayRow(), subjectRow(P_BAY, BAY_ID));
    expect((await errorOf(getTaskPeople(withDisplay(h.peopleDeps), caller(BAY_ID, "Bay Slack", "slack", BAY), TASK_A))).code).toBe("TASK_ACCESS_DENIED");
    expect(h.people()).toBeUndefined();
  });

  it("refuses to make a Slack person outside the channel an owner, and writes nothing", async () => {
    const h = harness({ task: sharedSlackTask(), outOfChannel: [BAY] });
    h.seed(samRow(), subjectRow(P_SAM, SAM_ID), bayRow(), subjectRow(P_BAY, BAY_ID), peopleRow([SAM_ENTRY("owner"), BAY_ENTRY("commenter")]));
    const before = JSON.stringify(h.people());
    expect((await errorOf(changeTaskPeople(h.peopleDeps, caller(SAM_ID, "Sam Slack", "slack", SAM), TASK_A, {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedPeopleRevision: 3, targetDeveloperId: BAY_ID, role: "owner",
    }))).code).toBe("TASK_ACCESS_DENIED");
    expect(JSON.stringify(h.people())).toBe(before);
  });

  it("never lets a Slack commenter outside the channel take ownership of an orphaned task", async () => {
    const h = harness({ task: sharedSlackTask(), outOfChannel: [BAY] });
    h.seed(samRow(), subjectRow(P_SAM, SAM_ID), bayRow(), subjectRow(P_BAY, BAY_ID), peopleRow([SAM_ENTRY("denied"), BAY_ENTRY("commenter")], 3, true));
    const bay = caller(BAY_ID, "Bay Slack", "slack", BAY);
    await expect(getTaskPeopleCapabilities(h.peopleDeps, bay, TASK_A)).resolves.toMatchObject({ canTakeOwnership: false });
    await expect(resolveTaskPeopleAccess(h.peopleDeps, sharedSlackTask(), BAY_ID)).resolves.toMatchObject({ role: "commenter", canTakeOwnership: false });
    expect((await errorOf(takeTaskOwnership(h.peopleDeps, bay, TASK_A, { requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expectedPeopleRevision: 3 }))).code).toBe("TASK_ACCESS_DENIED");
  });
});

describe("the dispatcher's membership read (withTaskPersonMembershipRead)", () => {
  const basePorts = {} as TaskPersonRuntimePorts;

  it("reads exactly COMPANY_MEMBER#<id> / COMPANY on the sign-in table, strongly, with the named fields only", async () => {
    const send = vi.fn(async (command: GetCommand, options?: { abortSignal?: AbortSignal }) => { void options; return { Item: { pk: `COMPANY_MEMBER#${GALE_ID}` } }; });
    const ports = withTaskPersonMembershipRead({ send }, "signin", basePorts);
    const signal = new AbortController().signal;
    await expect(ports.readCompanyMembership!({ developerId: GALE_ID, consistentRead: true, projection: TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES, abortSignal: signal })).resolves.toEqual({ pk: `COMPANY_MEMBER#${GALE_ID}` });
    const [command, options] = send.mock.calls[0]!;
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input).toMatchObject({ TableName: "signin", Key: { pk: `COMPANY_MEMBER#${GALE_ID}`, sk: "COMPANY" }, ConsistentRead: true });
    expect(Object.values(command.input.ExpressionAttributeNames ?? {})).toEqual([...TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES]);
    expect(command.input.ProjectionExpression?.split(", ")).toHaveLength(TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES.length);
    expect(options?.abortSignal).toBe(signal);
  });

  it.each([[undefined], [""], ["  "]])("adds no membership read without a sign-in table (%j), so web identities stay unavailable", (table) => {
    const send = vi.fn();
    expect("readCompanyMembership" in withTaskPersonMembershipRead({ send }, table, basePorts)).toBe(false);
  });
});
