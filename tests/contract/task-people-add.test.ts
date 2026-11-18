// Web task channel C4 (plan 4.2 "Add a person from the web"; decisions D3, D4, D5): a task owner lists the people of the task's company who hold a
// developer or administrator grant on its project (names and opaque ids only, at most 200, each proved live), and adds one: the person is registered
// (PERSON / PERSON_SUBJECT, which grants nothing) and the role goes through the same propose -> confirm step as every People change. Another company's
// people are never listed or added; a Slack sign-in is added through Slack; a web person gets no Slack invitation.
import { describe, expect, it, vi } from "vitest";
import { SLACK_OIDC_ISSUER, TaskPeopleAddRequestSchema, type TaskPersonProofRequest, type TaskPersonProofResponse } from "@agentx/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { WEB_PROOF_GRANT_ROWS_MAX, developerTaskRouteDependencies, type DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { renderTaskPeoplePanel } from "../../packages/broker/src/aws/task-people-page-view.js";
import { TASK_PAGE_API, createTaskWebApi } from "../../packages/broker/src/aws/task-web-api.js";
import {
  checkTaskPersonIdentity, listTaskWebCandidates, registerTaskWebPerson, type ProjectAccessSubject, type TaskPersonIdentityDependencies,
} from "../../packages/broker/src/developer/task-person-identity.js";
import { addTaskWebPerson, confirmTaskPeopleProposal, getTaskPeopleCandidates, type TaskPeopleEffectsDependencies } from "../../packages/broker/src/developer/task-people-effects.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import type { DeveloperRecord } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { companyProjectRow } from "../support/company-layout-projects.js";
import { T0, TEAM } from "../support/developer-fakes.js";

const TASK_A = "44444444-4444-4444-8444-444444444444";
const GH = "https://github.com";
const CLOUD = "https://cloud.example.test";
const GALE_ID = ownerKeyForSubject(GH, "gh-1234");
const WREN_ID = ownerKeyForSubject(CLOUD, "wren-7");
const BRYN_ID = ownerKeyForSubject(GH, "gh-bryn");
const NOOR_ID = ownerKeyForSubject(GH, "gh-noor");
const OIDC = "https://id.example.test";
const OLA_ID = ownerKeyForSubject(OIDC, "ola-1");
const IVY_ID = ownerKeyForSubject(GH, "gh-ivy");
const SAM = "U0SAMSLACK";
const SAM_ID = developerIdForSlackUser(SAM);
const P_GALE = "66666666-6666-4666-8666-666666666666";
const P_NEW = "77777777-7777-4777-8777-777777777777";
const CREATED = new Date(T0 - 60_000).toISOString();
const companyId = (letter: string) => `org_${letter.repeat(20)}`;
const COMPANY_A = companyId("a");
const COMPANY_B = companyId("b");
const REQUEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const webTask = (): DeveloperTaskRecord => ({
  pk: `DEVTASK#${TASK_A}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_A, developerId: GALE_ID, provider: "github", developerName: "Gale GitHub",
  client: "web", project: "payments", title: "Payments", workspaceId: `workspace-${TASK_A}`, ownerKey: "f".repeat(64), conversationId: "conversation",
  startingRevision: 1, charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } },
  shared: false, createdAt: CREATED, updatedAt: CREATED, companyId: COMPANY_A, workflow: { revision: 7, stage: "PLAN_REVIEW", state: "WAITING" },
} as unknown as DeveloperTaskRecord);

const record = (developerId: string, provider: DeveloperRecord["provider"], issuer: string, subject: string, name: string, overrides: Partial<DeveloperRecord> = {}): DeveloperRecord => ({
  developerId, provider, issuer, subject, displayName: name, firstSignInAt: CREATED, lastSignInAt: CREATED, revoked: false, ...overrides,
});
const GALE_CALLER: DeveloperCaller = { developerId: GALE_ID, name: "Gale GitHub", sessionId: "session-gale", amr: "github" };
const WREN_CALLER: DeveloperCaller = { developerId: WREN_ID, name: "Wren Cloud", sessionId: "session-wren", amr: "cloud" };
const GALE = (role: string) => ({ developerId: GALE_ID, name: "Gale GitHub", role, method: "github" });

const errorOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code?: string }; }
  throw new Error("expected refusal");
};

interface World { memberships?: Record<string, string | undefined>; grants?: Record<string, boolean>; members?: string[]; complete?: boolean; records?: Record<string, DeveloperRecord> }

function harness(world: World = {}) {
  const db = new FakeDynamoDb();
  db.set(webTask() as unknown as Record<string, unknown>);
  db.set({ pk: `DEVTASK#${TASK_A}`, sk: `PERSON#${P_GALE}`, schemaVersion: 1, personId: P_GALE, developerId: GALE_ID, name: "Gale GitHub", method: "github", issuer: GH, subject: "gh-1234", createdAt: CREATED });
  db.set({ pk: `DEVTASK#${TASK_A}`, sk: `PERSON_SUBJECT#${GALE_ID}`, schemaVersion: 1, personId: P_GALE, developerId: GALE_ID, createdAt: CREATED });
  db.set({ pk: `DEVTASK#${TASK_A}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: false, people: [GALE("owner")] });
  const records: Record<string, DeveloperRecord> = {
    [GALE_ID]: record(GALE_ID, "github", GH, "gh-1234", "Gale GitHub"),
    [WREN_ID]: record(WREN_ID, "cloud", CLOUD, "wren-7", "Wren Cloud"),
    [BRYN_ID]: record(BRYN_ID, "github", GH, "gh-bryn", "Bryn Other"),
    [NOOR_ID]: record(NOOR_ID, "github", GH, "gh-noor", "Noor Revoked", { revoked: true }),
    [SAM_ID]: record(SAM_ID, "slack", SLACK_OIDC_ISSUER, SAM, "Sam Slack", { slackUserId: SAM }),
    // M1: an OIDC sign-in linked to a Slack account is a Slack-kind person (added through Slack), never a web one.
    [OLA_ID]: record(OLA_ID, "oidc", OIDC, "ola-1", "Ola Linked", { slackUserId: SAM }),
    [IVY_ID]: record(IVY_ID, "github", GH, "gh-ivy", "Ivy Eligible"),
    ...(world.records ?? {}),
  };
  const memberships: Record<string, string | undefined> = { [GALE_ID]: COMPANY_A, [WREN_ID]: COMPANY_A, [BRYN_ID]: COMPANY_B, [NOOR_ID]: COMPANY_A, [SAM_ID]: COMPANY_A, [OLA_ID]: COMPANY_A, [IVY_ID]: COMPANY_A, ...(world.memberships ?? {}) };
  const grants: Record<string, boolean> = { [GALE_ID]: true, [WREN_ID]: true, [BRYN_ID]: true, [NOOR_ID]: true, [SAM_ID]: true, [OLA_ID]: true, [IVY_ID]: true, ...(world.grants ?? {}) };
  const proof = vi.fn(async (request: TaskPersonProofRequest): Promise<TaskPersonProofResponse> => ({ ok: true, user: { id: request.slackUserId, teamId: TEAM, name: "Sam" }, memberOf: [] }));
  const projectMemberIds = vi.fn(async (project: string, limit: number) => {
    void project;
    const ids = world.members ?? [GALE_ID, WREN_ID, BRYN_ID, NOOR_ID, SAM_ID, OLA_ID];
    return { ids: ids.slice(0, limit), complete: world.complete ?? true };
  });
  const uuids = [P_NEW];
  const identityDeps: TaskPersonIdentityDependencies = {
    documentClient: db, tableName: "state", slackTeamId: TEAM, now: () => T0, uuid: () => uuids.shift() ?? P_NEW, taskPersonProof: proof,
    developerRecord: async (developerId) => records[developerId],
    projectChannelIds: async () => [],
    targetProjectAccess: async (subject: ProjectAccessSubject, project: string, memberOf: readonly string[]) => { void [subject, project, memberOf]; },
    companyMembership: async (developerId) => {
      const found = memberships[developerId];
      if (found === "throw") throw new Error("down");
      return found === undefined ? undefined : { companyId: found };
    },
    projectGrant: async (developerId) => grants[developerId] ?? false,
    projectMemberIds,
  };
  const deps: TaskPeopleEffectsDependencies = {
    documentClient: db, tableName: "state", now: () => T0, issuer: "https://code.example.test", taskPeopleConfiguration: { peopleChangesEnabled: true },
    checkTaskPerson: (task, developerId) => checkTaskPersonIdentity(identityDeps, task, developerId),
    registerTaskWebPerson: (task, developerId) => registerTaskWebPerson(identityDeps, task, developerId),
    listTaskWebCandidates: (task, limit) => listTaskWebCandidates(identityDeps, task, GALE_ID, limit),
  };
  return { db, identityDeps, deps, proof, projectMemberIds };
}

describe("candidates (GET people/candidates)", () => {
  it("lists only live members of the task's company with a grant and a current web sign-in, never the caller, another company, a revoked or a Slack sign-in", async () => {
    const h = harness();
    await expect(getTaskPeopleCandidates(h.deps, GALE_CALLER, TASK_A)).resolves.toStrictEqual({ candidates: [{ developerId: WREN_ID, name: "Wren Cloud" }], complete: true });
    expect(h.projectMemberIds).toHaveBeenCalledWith("payments", 200);
    expect(h.proof).not.toHaveBeenCalled();
  });

  it("leaves out anyone without a grant, and anyone whose membership cannot be read", async () => {
    expect((await getTaskPeopleCandidates(harness({ grants: { [WREN_ID]: false } }).deps, GALE_CALLER, TASK_A)).candidates).toEqual([]);
    expect((await getTaskPeopleCandidates(harness({ memberships: { [WREN_ID]: "throw" } }).deps, GALE_CALLER, TASK_A)).candidates).toEqual([]);
  });

  it("says when the project had more people than were checked, and never asks for more than 200", async () => {
    const h = harness({ complete: false });
    await expect(getTaskPeopleCandidates(h.deps, GALE_CALLER, TASK_A)).resolves.toMatchObject({ complete: false });
    await expect(listTaskWebCandidates(h.identityDeps, webTask(), GALE_ID, 201)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("is owner only: a commenter is refused and nothing is read", async () => {
    const h = harness();
    h.db.set({ pk: `DEVTASK#${TASK_A}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: false, people: [GALE("owner"), { developerId: WREN_ID, name: "Wren Cloud", role: "commenter", method: "cloud" }] });
    h.db.set({ pk: `DEVTASK#${TASK_A}`, sk: "PERSON#88888888-8888-4888-8888-888888888888", schemaVersion: 1, personId: "88888888-8888-4888-8888-888888888888", developerId: WREN_ID, name: "Wren Cloud", method: "cloud", issuer: CLOUD, subject: "wren-7", createdAt: CREATED });
    h.db.set({ pk: `DEVTASK#${TASK_A}`, sk: `PERSON_SUBJECT#${WREN_ID}`, schemaVersion: 1, personId: "88888888-8888-4888-8888-888888888888", developerId: WREN_ID, createdAt: CREATED });
    expect((await errorOf(getTaskPeopleCandidates(h.deps, WREN_CALLER, TASK_A))).code).toBe("TASK_ACCESS_DENIED");
    expect(h.projectMemberIds).not.toHaveBeenCalled();
  });

  it("is unavailable (fixed words) when the project's people cannot be read, or the read is not wired", async () => {
    const h = harness();
    h.projectMemberIds.mockRejectedValueOnce(new Error("secret cause"));
    const error = await errorOf(getTaskPeopleCandidates(h.deps, GALE_CALLER, TASK_A));
    expect(error.code).toBe("RUNTIME_UNAVAILABLE");
    expect(error.message).not.toContain("secret cause");
    const bare = harness();
    delete bare.deps.listTaskWebCandidates;
    expect((await errorOf(getTaskPeopleCandidates(bare.deps, GALE_CALLER, TASK_A))).code).toBe("RUNTIME_UNAVAILABLE");
  });
});

describe("candidates: the lister's answer is checked", () => {
  it("is unavailable when the project lister returns more ids than were asked for", async () => {
    const h = harness();
    h.projectMemberIds.mockResolvedValueOnce({ ids: Array.from({ length: 201 }, (_, index) => index.toString(16).padStart(64, "0")), complete: true });
    expect((await errorOf(listTaskWebCandidates(h.identityDeps, webTask(), GALE_ID, 200))).code).toBe("SLACK_UNAVAILABLE");
  });

  it("is unavailable when the list handed to the effects carries anything beyond names and ids", async () => {
    const h = harness();
    h.deps.listTaskWebCandidates = async () => ({ candidates: [{ developerId: WREN_ID, name: "Wren Cloud", email: "wren@example.test" }], complete: true });
    expect((await errorOf(getTaskPeopleCandidates(h.deps, GALE_CALLER, TASK_A))).code).toBe("RUNTIME_UNAVAILABLE");
  });
});

describe("candidates: the read budget on the route wiring", () => {
  const SIGNIN = "signin";
  function routeWorld(extraGrantRows = 0) {
    const db = new FakeDynamoDb();
    const meta = webTask();
    db.set(meta as unknown as Record<string, unknown>);
    db.set(companyProjectRow(COMPANY_A, "payments", 7)); // DEC 254zzz80: the project in its company's own partition
    const KAI_ID = ownerKeyForSubject(GH, "gh-kai");
    const people = [
      record(WREN_ID, "cloud", CLOUD, "wren-7", "Wren Cloud"),
      record(IVY_ID, "github", GH, "gh-ivy", "Ivy Eligible"),
      record(KAI_ID, "github", GH, "gh-kai", "Kai Eligible"),
    ];
    for (const person of people) {
      const developerId = person.developerId;
      db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", ...person });
      db.set({ pk: `COMPANY_MEMBER#${developerId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: developerId, companyId: COMPANY_A, role: "member", joinedAt: CREATED });
      db.set({ pk: `MEMBER#${developerId}`, sk: "PROJECT#payments", projectName: "payments", role: "developer" });
      db.set({ pk: "PROJECT_MEMBERS#payments", sk: `DEVELOPER#${developerId}`, projectName: "payments", developerId });
    }
    for (let index = 0; index < extraGrantRows; index += 1) db.set({ pk: `MEMBER#${WREN_ID}`, sk: `PROJECT#extra-${String(index).padStart(4, "0")}`, projectName: `extra-${index}`, role: "viewer" });
    const queries: Array<{ pk: unknown; prefix: unknown }> = [];
    const counting = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "QueryCommand") queries.push({ pk: (command.input.ExpressionAttributeValues as Record<string, unknown>)[":pk"], prefix: (command.input.ExpressionAttributeValues as Record<string, unknown>)[":prefix"] });
      return db.send(command);
    } };
    const developer = { signInTableName: SIGNIN, issuer: "https://code.example.test", companies: companyMembershipFromDynamo(db, SIGNIN) };
    const deps = developerTaskRouteDependencies({ documentClient: counting, tableName: "state", developer, now: () => T0, tasks: {} } as never, GALE_CALLER);
    return { deps, meta, queries };
  }

  it("reads the project definition once however many people are proved", async () => {
    const { deps, meta, queries } = routeWorld();
    const listed = await deps.listTaskWebCandidates!(meta, 200);
    expect(listed.candidates.length).toBeGreaterThanOrEqual(2);
    expect(queries.filter((query) => query.pk === `ORG#${COMPANY_A}#PROJECT#payments`)).toHaveLength(1);
  });

  it("leaves out a person whose grant rows exceed the cap, and keeps the others", async () => {
    const { deps, meta } = routeWorld(WEB_PROOF_GRANT_ROWS_MAX + 1);
    const names = (await deps.listTaskWebCandidates!(meta, 200)).candidates.map((candidate) => candidate.developerId);
    expect(names).not.toContain(WREN_ID);
    expect(names).toContain(IVY_ID);
  });
});

describe("add (POST people/add) through propose -> confirm", () => {
  it("registers a web candidate, proposes the role, and the confirm step writes the web entry with no Slack invitation", async () => {
    const h = harness();
    const proposed = await addTaskWebPerson(h.deps, GALE_CALLER, TASK_A, { requestId: REQUEST, expectedPeopleRevision: 3, developerId: WREN_ID, role: "commenter" });
    expect(proposed).toMatchObject({ status: "PENDING", requestId: REQUEST, confirmationUrl: `https://code.example.test/review/${TASK_A}/task/people/confirm/${REQUEST}` });
    expect(h.db.get(`DEVTASK#${TASK_A}`, `PERSON#${P_NEW}`)).toStrictEqual({
      pk: `DEVTASK#${TASK_A}`, sk: `PERSON#${P_NEW}`, schemaVersion: 1, personId: P_NEW, developerId: WREN_ID, name: "Wren Cloud", method: "cloud", issuer: CLOUD, subject: "wren-7", createdAt: new Date(T0).toISOString(),
    });
    // Registered but not confirmed: no role yet, so no access (C3: a web identity holds only a role someone gave it).
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 3, people: [GALE("owner")] });
    const committed = await confirmTaskPeopleProposal(h.deps, GALE_CALLER, TASK_A, REQUEST);
    expect(committed.status).toBe("COMMITTED");
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 4, people: [GALE("owner"), { developerId: WREN_ID, name: "Wren Cloud", role: "commenter", method: "cloud" }] });
    expect(h.db.find((item) => String(item.sk).startsWith("PEOPLE_NOTIFY#"))).toEqual([]);
    expect(h.proof).not.toHaveBeenCalled();
  });

  it("answers a replay of the same request with the same pending change", async () => {
    const h = harness();
    const input = { requestId: REQUEST, expectedPeopleRevision: 3, developerId: WREN_ID, role: "viewer" as const };
    const first = await addTaskWebPerson(h.deps, GALE_CALLER, TASK_A, input);
    await expect(addTaskWebPerson(h.deps, GALE_CALLER, TASK_A, input)).resolves.toStrictEqual(first);
  });

  it.each([3, 4])("refuses another owner's request ID before registration with expected People revision %s", async (revision) => {
    const h = harness();
    await addTaskWebPerson(h.deps, GALE_CALLER, TASK_A, { requestId: REQUEST, expectedPeopleRevision: 3, developerId: WREN_ID, role: "owner" });
    await confirmTaskPeopleProposal(h.deps, GALE_CALLER, TASK_A, REQUEST);
    h.identityDeps.uuid = () => "88888888-8888-4888-8888-888888888888";
    const before = structuredClone(h.db.find(() => true));
    const register = vi.spyOn(h.deps, "registerTaskWebPerson");

    const error = await errorOf(addTaskWebPerson(h.deps, WREN_CALLER, TASK_A, {
      requestId: REQUEST, expectedPeopleRevision: revision, developerId: IVY_ID, role: "viewer",
    }));

    expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(error.message).toBe("IDEMPOTENCY_CONFLICT: this People request ID was already used");
    expect(register).not.toHaveBeenCalled();
    expect(h.db.find((item) => item.developerId === IVY_ID)).toEqual([]);
    expect(h.db.find(() => true)).toStrictEqual(before);
  });

  it.each([
    ["a member of another company (even with a grant on a same-named project)", BRYN_ID],
    ["a person with a revoked sign-in", NOOR_ID],
    ["a Slack sign-in (added through Slack)", SAM_ID],
    ["an OIDC sign-in linked to Slack (added through Slack, keeps the Slack proof)", OLA_ID],
    ["someone with no sign-in record", ownerKeyForSubject(GH, "gh-ghost")],
  ])("refuses %s with fixed words and writes nothing", async (_label, developerId) => {
    const h = harness();
    const error = await errorOf(addTaskWebPerson(h.deps, GALE_CALLER, TASK_A, { requestId: REQUEST, expectedPeopleRevision: 3, developerId, role: "commenter" }));
    expect(error.code).toBe("TASK_ACCESS_DENIED");
    expect(error.message).toContain("That person can't be added to this task");
    expect(error.message).not.toContain(developerId);
    expect(h.db.find((item) => String(item.sk).startsWith("PERSON") && item.developerId === developerId)).toEqual([]);
    expect(h.db.find((item) => String(item.sk).startsWith("PEOPLE_PROPOSAL#"))).toEqual([]);
  });

  it("refuses a person without a grant, and is unavailable when their membership cannot be read", async () => {
    expect((await errorOf(addTaskWebPerson(harness({ grants: { [WREN_ID]: false } }).deps, GALE_CALLER, TASK_A, { requestId: REQUEST, expectedPeopleRevision: 3, developerId: WREN_ID, role: "commenter" }))).code).toBe("TASK_ACCESS_DENIED");
    expect((await errorOf(addTaskWebPerson(harness({ memberships: { [WREN_ID]: "throw" } }).deps, GALE_CALLER, TASK_A, { requestId: REQUEST, expectedPeopleRevision: 3, developerId: WREN_ID, role: "commenter" }))).code).toBe("RUNTIME_UNAVAILABLE");
  });

  it("is owner only: a non-owner cannot add, and nothing is written", async () => {
    const h = harness();
    expect((await errorOf(addTaskWebPerson(h.deps, WREN_CALLER, TASK_A, { requestId: REQUEST, expectedPeopleRevision: 3, developerId: WREN_ID, role: "owner" }))).code).toBe("TASK_ACCESS_DENIED");
    expect(h.db.find((item) => item.developerId === WREN_ID)).toEqual([]);
  });

  it("is owner only: a commenter who tries to add a third member is refused, and no PERSON row is written for the target", async () => {
    const h = harness();
    h.db.set({ pk: `DEVTASK#${TASK_A}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: false, people: [GALE("owner"), { developerId: WREN_ID, name: "Wren Cloud", role: "commenter", method: "cloud" }] });
    h.db.set({ pk: `DEVTASK#${TASK_A}`, sk: "PERSON#88888888-8888-4888-8888-888888888888", schemaVersion: 1, personId: "88888888-8888-4888-8888-888888888888", developerId: WREN_ID, name: "Wren Cloud", method: "cloud", issuer: CLOUD, subject: "wren-7", createdAt: CREATED });
    h.db.set({ pk: `DEVTASK#${TASK_A}`, sk: `PERSON_SUBJECT#${WREN_ID}`, schemaVersion: 1, personId: "88888888-8888-4888-8888-888888888888", developerId: WREN_ID, createdAt: CREATED });
    for (const role of ["owner", "commenter", "viewer"] as const) {
      expect((await errorOf(addTaskWebPerson(h.deps, WREN_CALLER, TASK_A, { requestId: REQUEST, expectedPeopleRevision: 3, developerId: IVY_ID, role }))).code).toBe("TASK_ACCESS_DENIED");
    }
    expect(h.db.find((item) => item.developerId === IVY_ID)).toEqual([]);
    expect(h.db.find((item) => String(item.sk).startsWith("PEOPLE_PROPOSAL#"))).toEqual([]);
  });

  it("refuses a stale People revision, and writes no PERSON row for it (the revision is checked before registering)", async () => {
    const h = harness();
    const before = structuredClone(h.db.find(() => true));
    const register = vi.spyOn(h.deps, "registerTaskWebPerson");
    expect((await errorOf(addTaskWebPerson(h.deps, GALE_CALLER, TASK_A, { requestId: REQUEST, expectedPeopleRevision: 2, developerId: WREN_ID, role: "commenter" }))).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(register).not.toHaveBeenCalled();
    expect(h.db.find((item) => item.developerId === WREN_ID)).toEqual([]);
    expect(h.db.find(() => true)).toStrictEqual(before);
  });

  it("still answers a replay of a committed request after the People revision moved on", async () => {
    const h = harness();
    const input = { requestId: REQUEST, expectedPeopleRevision: 3, developerId: WREN_ID, role: "commenter" as const };
    await addTaskWebPerson(h.deps, GALE_CALLER, TASK_A, input);
    const committed = await confirmTaskPeopleProposal(h.deps, GALE_CALLER, TASK_A, REQUEST);
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 4 });
    await expect(addTaskWebPerson(h.deps, GALE_CALLER, TASK_A, input)).resolves.toStrictEqual(committed);
  });

  it("takes only owner, commenter or viewer (removal stays role `denied` through people/role)", () => {
    expect(TaskPeopleAddRequestSchema.safeParse({ requestId: REQUEST, expectedPeopleRevision: 3, developerId: WREN_ID, role: "denied" }).success).toBe(false);
    expect(TaskPeopleAddRequestSchema.safeParse({ requestId: REQUEST, expectedPeopleRevision: 3, developerId: "x", role: "viewer" }).success).toBe(false);
    expect(TaskPeopleAddRequestSchema.safeParse({ requestId: REQUEST, expectedPeopleRevision: 3, developerId: WREN_ID, role: "viewer", companyId: COMPANY_B }).success).toBe(false);
  });
});

describe("the task page's People panel", () => {
  const view = (canManage: boolean, addPeopleUrl?: string) => ({
    revision: 3, orphaned: false, canManage, canTakeOwnership: false,
    people: [{ personId: P_GALE, name: "Gale GitHub", role: "owner" as const, you: true, effectiveRole: "owner" as const }],
    ...(addPeopleUrl === undefined ? {} : { addPeopleUrl }),
  });

  it("shows an owner the web add instead of the Slack-only words on a task with no Slack share", () => {
    const html = renderTaskPeoplePanel(TASK_A, view(true));
    expect(html).toContain('data-people-add-form data-people-revision="3"');
    expect(html).not.toContain("Add people in Slack");
    expect(html).not.toContain("Invite them to this task channel in Slack");
  });

  it("keeps the Slack link beside the web add on a Slack-shared task, and shows no add form to anyone else", () => {
    const shared = renderTaskPeoplePanel(TASK_A, view(true, "https://slack.com/app_redirect?team=T0TEAM1&channel=C0WEBTASK1"));
    expect(shared).toContain("data-people-add-form");
    expect(renderTaskPeoplePanel(TASK_A, view(false))).not.toContain("data-people-add-form");
  });
});

describe("the task page API (people/candidates, people/add)", () => {
  const ORIGIN = "https://code.example.test";
  const CSRF = "c".repeat(43);
  const SESSION_ID = "22222222-2222-4222-8222-222222222222";
  const cookie = `__Host-agentx_review_session=${SESSION_ID}; __Host-agentx_review_csrf=${CSRF}`;
  const api = (suffix: string) => `/review/${TASK_A}/task/api/${suffix}`;
  const pageDeps = (overrides: Record<string, unknown> = {}) => {
    const calls: Array<{ name: string; input?: unknown; caller: DeveloperCaller }> = [];
    return {
      calls,
      deps: {
        origin: ORIGIN,
        authenticateSession: async (sessionId: string) => (sessionId === SESSION_ID ? GALE_CALLER : undefined),
        taskState: async () => ({ revision: 4, waiting: false, stage: "Coding plan", documents: [], commentSeq: 0, canRead: true, canComment: true, canSuggest: false, canDecide: false, canAsk: false, canManagePeople: true, canTakeOwnership: false }),
        listComments: async () => ({ comments: [] }),
        createComment: async () => ({}) as never, editComment: async () => ({}) as never, deleteComment: async () => ({}) as never,
        setSuggestion: async () => ({}) as never, decide: async () => ({ revision: 5 }),
        getPeopleCandidates: async (who: DeveloperCaller) => { calls.push({ name: "candidates", caller: who }); return { candidates: [{ developerId: WREN_ID, name: "Wren Cloud" }], complete: true }; },
        addPeople: async (who: DeveloperCaller, _taskId: string, input: unknown) => { calls.push({ name: "add", caller: who, input }); return { status: "PENDING" as const, requestId: REQUEST, confirmationUrl: `${ORIGIN}/review/${TASK_A}/task/people/confirm/${REQUEST}`, expiresAt: new Date(T0).toISOString() }; },
        ...overrides,
      } as never,
    };
  };
  const call = async (deps: never, request: { method: string; path: string; body?: string; headers: Record<string, string> }) => {
    const response = await createTaskWebApi(deps)({ requestId: "r", ...request }, new URL(`${ORIGIN}${request.path}`));
    return { status: response.statusCode, json: JSON.parse(response.body) as Record<string, unknown> };
  };

  it("serves the candidates read (GET only) with the session's own caller", async () => {
    expect(TASK_PAGE_API.test(api("people/candidates"))).toBe(true);
    const h = pageDeps();
    await expect(call(h.deps, { method: "GET", path: api("people/candidates"), headers: { cookie } })).resolves.toMatchObject({ status: 200, json: { candidates: [{ developerId: WREN_ID, name: "Wren Cloud" }] } });
    expect(h.calls).toEqual([{ name: "candidates", caller: GALE_CALLER }]);
    expect((await call(h.deps, { method: "POST", path: api("people/candidates"), body: "{}", headers: { cookie, origin: ORIGIN, "x-agentx-csrf": CSRF, "content-type": "application/json" } })).status).toBe(405);
  });

  it("takes an addition only same-origin with the CSRF header and a strict body", async () => {
    const h = pageDeps();
    const body = JSON.stringify({ requestId: REQUEST, expectedPeopleRevision: 3, developerId: WREN_ID, role: "commenter" });
    const headers = { cookie, origin: ORIGIN, "x-agentx-csrf": CSRF, "content-type": "application/json" };
    await expect(call(h.deps, { method: "POST", path: api("people/add"), body, headers })).resolves.toMatchObject({ status: 202, json: { status: "PENDING", requestId: REQUEST } });
    expect(h.calls).toEqual([{ name: "add", caller: GALE_CALLER, input: JSON.parse(body) as unknown }]);
    expect((await call(h.deps, { method: "POST", path: api("people/add"), body, headers: { ...headers, origin: "https://evil.example" } })).status).toBe(403);
    expect((await call(h.deps, { method: "POST", path: api("people/add"), body, headers: { ...headers, "x-agentx-csrf": "d".repeat(43) } })).status).toBe(403);
    expect((await call(h.deps, { method: "POST", path: api("people/add"), body: JSON.stringify({ ...JSON.parse(body), companyId: COMPANY_B }), headers })).status).toBe(400);
    expect(h.calls).toHaveLength(1);
  });

  it("answers not found when the deployment wires no addition", async () => {
    const h = pageDeps({ getPeopleCandidates: undefined, addPeople: undefined });
    expect((await call(h.deps, { method: "GET", path: api("people/candidates"), headers: { cookie } })).status).toBe(404);
  });
});
