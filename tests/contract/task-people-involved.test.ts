// Web task channel, involved wiring: the People commit keeps the person's involved row (`ORG#<company>#INVOLVED#<person>` / `TASK#<createdAt>#<taskId>`, C5) in the SAME transaction as the change.
// An owner after the change has the row (added as owner, promoted, taking ownership); any other role (commenter, viewer, denied) deletes it; the row is in the TASK'S company, never for the task's own
// person, and only for core tasks (a record with a `companyId`). The row grants nothing: the reader re-checks. A change that does not commit writes no row.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type TaskPersonProofRequest, type TaskPersonProofResponse } from "@agentx/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { checkTaskPersonIdentity, listTaskWebCandidates, registerTaskWebPerson, type ProjectAccessSubject, type TaskPersonIdentityDependencies } from "../../packages/broker/src/developer/task-person-identity.js";
import { addTaskWebPerson, confirmTaskPeopleProposal, proposeTaskOwnership, proposeTaskPeopleRole, type TaskPeopleEffectsDependencies } from "../../packages/broker/src/developer/task-people-effects.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import type { DeveloperRecord } from "../../packages/broker/src/developer/store.js";
import { INVOLVED_ENTITY, involvedRowKey, involvedTaskIds } from "../../packages/broker/src/core/task-flow/involved.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { T0, TEAM } from "../support/developer-fakes.js";

const TASK_A = "44444444-4444-4444-8444-444444444444";
const GH = "https://github.com";
const CLOUD = "https://cloud.example.test";
const GALE_ID = ownerKeyForSubject(GH, "gh-1234");
const WREN_ID = ownerKeyForSubject(CLOUD, "wren-7");
const IVY_ID = ownerKeyForSubject(GH, "gh-ivy");
const P_GALE = "66666666-6666-4666-8666-666666666666";
const P_NEW = "77777777-7777-4777-8777-777777777777";
const CREATED = new Date(T0 - 60_000).toISOString();
const companyId = (letter: string) => `org_${letter.repeat(20)}`;
const COMPANY_A = companyId("a");
const COMPANY_B = companyId("b");
const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const GALE_CALLER: DeveloperCaller = { developerId: GALE_ID, name: "Gale GitHub", sessionId: "session-gale", amr: "github" };
const WREN_CALLER: DeveloperCaller = { developerId: WREN_ID, name: "Wren Cloud", sessionId: "session-wren", amr: "cloud" };
const GALE = (role: string) => ({ developerId: GALE_ID, name: "Gale GitHub", role, method: "github" });
const WREN = (role: string) => ({ developerId: WREN_ID, name: "Wren Cloud", role, method: "cloud" });

const taskRecord = (company: string | undefined): DeveloperTaskRecord => ({
  pk: `DEVTASK#${TASK_A}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_A, developerId: GALE_ID, provider: "github", developerName: "Gale GitHub",
  client: "web", project: "payments", title: "Payments", workspaceId: `workspace-${TASK_A}`, ownerKey: "f".repeat(64), conversationId: "conversation",
  startingRevision: 1, charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } },
  shared: false, createdAt: CREATED, updatedAt: CREATED, ...(company === undefined ? {} : { companyId: company }), workflow: { revision: 7, stage: "PLAN_REVIEW", state: "WAITING" },
} as unknown as DeveloperTaskRecord);

const record = (developerId: string, provider: DeveloperRecord["provider"], issuer: string, subject: string, name: string): DeveloperRecord => ({
  developerId, provider, issuer, subject, displayName: name, firstSignInAt: CREATED, lastSignInAt: CREATED, revoked: false,
});

interface Options { createdAt?: string; company?: string | undefined; memberOf?: string; people?: { revision: number; orphaned: boolean; people: unknown[] }; wrenRegistered?: boolean }

function harness(options: Options = {}) {
  const company = "company" in options ? options.company : COMPANY_A;
  const memberOf = options.memberOf ?? COMPANY_A;
  const db = new FakeDynamoDb();
  db.set({ ...taskRecord(company), ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }) } as unknown as Record<string, unknown>);
  db.set({ pk: `DEVTASK#${TASK_A}`, sk: `PERSON#${P_GALE}`, schemaVersion: 1, personId: P_GALE, developerId: GALE_ID, name: "Gale GitHub", method: "github", issuer: GH, subject: "gh-1234", createdAt: CREATED });
  db.set({ pk: `DEVTASK#${TASK_A}`, sk: `PERSON_SUBJECT#${GALE_ID}`, schemaVersion: 1, personId: P_GALE, developerId: GALE_ID, createdAt: CREATED });
  db.set({ pk: `DEVTASK#${TASK_A}`, sk: "PEOPLE", schemaVersion: 1, ...(options.people ?? { revision: 3, orphaned: false, people: [GALE("owner")] }) });
  if (options.wrenRegistered === true) {
    const p = "88888888-8888-4888-8888-888888888888";
    db.set({ pk: `DEVTASK#${TASK_A}`, sk: `PERSON#${p}`, schemaVersion: 1, personId: p, developerId: WREN_ID, name: "Wren Cloud", method: "cloud", issuer: CLOUD, subject: "wren-7", createdAt: CREATED });
    db.set({ pk: `DEVTASK#${TASK_A}`, sk: `PERSON_SUBJECT#${WREN_ID}`, schemaVersion: 1, personId: p, developerId: WREN_ID, createdAt: CREATED });
  }
  const records: Record<string, DeveloperRecord> = {
    [GALE_ID]: record(GALE_ID, "github", GH, "gh-1234", "Gale GitHub"),
    [WREN_ID]: record(WREN_ID, "cloud", CLOUD, "wren-7", "Wren Cloud"),
    [IVY_ID]: record(IVY_ID, "github", GH, "gh-ivy", "Ivy Eligible"),
  };
  const identityDeps: TaskPersonIdentityDependencies = {
    documentClient: db, tableName: "state", slackTeamId: TEAM, now: () => T0, uuid: () => "77777777-7777-4777-8777-777777777777",
    taskPersonProof: async (request: TaskPersonProofRequest): Promise<TaskPersonProofResponse> => ({ ok: true, user: { id: request.slackUserId, teamId: TEAM, name: "x" }, memberOf: [] }),
    developerRecord: async (developerId) => records[developerId],
    projectChannelIds: async () => [],
    targetProjectAccess: async (subject: ProjectAccessSubject, project: string, members: readonly string[]) => { void [subject, project, members]; },
    companyMembership: async () => ({ companyId: memberOf }),
    projectGrant: async () => true,
    projectMemberIds: async () => ({ ids: [GALE_ID, WREN_ID, IVY_ID], complete: true }),
  };
  const deps: TaskPeopleEffectsDependencies = {
    documentClient: db, tableName: "state", now: () => T0, issuer: "https://code.example.test", taskPeopleConfiguration: { peopleChangesEnabled: true },
    checkTaskPerson: (task, developerId) => checkTaskPersonIdentity(identityDeps, task, developerId),
    registerTaskWebPerson: (task, developerId) => registerTaskWebPerson(identityDeps, task, developerId),
    listTaskWebCandidates: (task, limit) => listTaskWebCandidates(identityDeps, task, GALE_ID, limit),
  };
  const rowKeyOf = (company: string, personId: string) => involvedRowKey({ companyId: company, personId, taskId: TASK_A, createdAt: CREATED });
  const rowIn = (company: string, personId: string) => { const key = rowKeyOf(company, personId); return db.get(key.pk, key.sk); };
  const involvedItems = () => db.find((item) => item.entityType === INVOLVED_ENTITY);
  /** Add Wren (web) with the role through propose -> confirm, as the owner. */
  const add = async (role: "owner" | "commenter" | "viewer", n = 1, revision = 3) => {
    await addTaskWebPerson(deps, GALE_CALLER, TASK_A, { requestId: uuid(n), expectedPeopleRevision: revision, developerId: WREN_ID, role });
    return confirmTaskPeopleProposal(deps, GALE_CALLER, TASK_A, uuid(n));
  };
  /** A role change of the registered Wren, as the owner. */
  const change = async (role: "owner" | "commenter" | "viewer" | "denied", n: number, revision: number, caller: DeveloperCaller = GALE_CALLER, personId = P_NEW) => {
    await proposeTaskPeopleRole(deps, caller, TASK_A, { requestId: uuid(n), expectedPeopleRevision: revision, personId, role });
    return confirmTaskPeopleProposal(deps, caller, TASK_A, uuid(n));
  };
  return { db, deps, rowKeyOf, rowIn, involvedItems, add, change };
}

describe("an owner added from the web has an involved row, written with the People change", () => {
  it("writes exactly one pointer in the task's company for the new owner, with the task's id and creation time and nothing else about the task", async () => {
    const h = harness();
    await expect(h.add("owner")).resolves.toMatchObject({ status: "COMMITTED" });
    expect(h.rowIn(COMPANY_A, WREN_ID)).toStrictEqual({
      ...h.rowKeyOf(COMPANY_A, WREN_ID), entityType: INVOLVED_ENTITY, companyId: COMPANY_A, personId: WREN_ID, taskId: TASK_A, createdAt: CREATED, addedAt: new Date(T0).toISOString(),
    });
    expect(h.involvedItems()).toHaveLength(1);
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 4, people: [GALE("owner"), WREN("owner")] });
  });

  it("puts the row in the TASK'S company only: the same person has nothing in another company, and a task of another company writes only there", async () => {
    const a = harness();
    await a.add("owner");
    expect(a.rowIn(COMPANY_B, WREN_ID)).toBeUndefined();
    expect(a.involvedItems().map((item) => item.pk)).toEqual([a.rowKeyOf(COMPANY_A, WREN_ID).pk]);
    const b = harness({ company: COMPANY_B, memberOf: COMPANY_B });
    await b.add("owner");
    expect(b.rowIn(COMPANY_B, WREN_ID)).toMatchObject({ companyId: COMPANY_B, taskId: TASK_A });
    expect(b.rowIn(COMPANY_A, WREN_ID)).toBeUndefined();
    expect(b.involvedItems()).toHaveLength(1);
  });

  it("writes the row only for the person the change names, never for the caller or the task's own person", async () => {
    const h = harness();
    await h.add("owner");
    expect(h.rowIn(COMPANY_A, GALE_ID)).toBeUndefined();
    expect(h.involvedItems().map((item) => item.personId)).toEqual([WREN_ID]);
  });

  it("is idempotent: the same confirmed request again leaves one row and the same answer", async () => {
    const h = harness();
    await h.add("owner");
    const again = await confirmTaskPeopleProposal(h.deps, GALE_CALLER, TASK_A, uuid(1));
    expect(again.status).toBe("COMMITTED");
    expect(h.involvedItems()).toHaveLength(1);
  });

  it("does not let a creation time that is not an instant block the People change (no row, change committed)", async () => {
    const h = harness({ createdAt: "yesterday" });
    await expect(h.add("owner")).resolves.toMatchObject({ status: "COMMITTED" });
    expect(h.involvedItems()).toEqual([]);
  });

  it("gives a task of an install without a company (a legacy record) no row, and the add still stands", async () => {
    const h = harness({ company: undefined, memberOf: IMPLICIT_COMPANY_ID });
    await expect(h.add("owner")).resolves.toMatchObject({ status: "COMMITTED" });
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 4 });
    expect(h.involvedItems()).toEqual([]);
  });
});

describe("a person who is not an owner has no involved row", () => {
  it.each(["commenter", "viewer"] as const)("adding someone as a %s writes no row (the list and the cards read owners only)", async (role) => {
    const h = harness();
    await expect(h.add(role)).resolves.toMatchObject({ status: "COMMITTED" });
    expect(h.involvedItems()).toEqual([]);
  });

  it.each(["commenter", "viewer", "denied"] as const)("changing an owner to %s deletes their row, in the same commit", async (role) => {
    const h = harness();
    await h.add("owner", 1);
    expect(h.rowIn(COMPANY_A, WREN_ID)).toBeDefined();
    await expect(h.change(role, 2, 4)).resolves.toMatchObject({ status: "COMMITTED" });
    expect(h.rowIn(COMPANY_A, WREN_ID)).toBeUndefined();
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 5 });
  });

  it("removing someone who has no row is quiet (nothing to delete)", async () => {
    const h = harness();
    await h.add("commenter", 1);
    await expect(h.change("denied", 2, 4)).resolves.toMatchObject({ status: "COMMITTED" });
    expect(h.involvedItems()).toEqual([]);
  });

  it("promoting a commenter to owner writes the row", async () => {
    const h = harness();
    await h.add("commenter", 1);
    expect(h.involvedItems()).toEqual([]);
    await h.change("owner", 2, 4);
    expect(h.rowIn(COMPANY_A, WREN_ID)).toMatchObject({ personId: WREN_ID, taskId: TASK_A });
  });

  it("removing one owner leaves the other owner's row", async () => {
    const h = harness({ wrenRegistered: true, people: { revision: 3, orphaned: false, people: [GALE("owner"), WREN("owner")] } });
    h.db.set({ ...h.rowKeyOf(COMPANY_A, WREN_ID), entityType: INVOLVED_ENTITY, companyId: COMPANY_A, personId: WREN_ID, taskId: TASK_A, createdAt: CREATED, addedAt: CREATED });
    // Gale (the creator) steps down: no row is made for the creator, and Wren's stays.
    await proposeTaskPeopleRole(h.deps, GALE_CALLER, TASK_A, { requestId: uuid(5), expectedPeopleRevision: 3, personId: P_GALE, role: "commenter" });
    await confirmTaskPeopleProposal(h.deps, GALE_CALLER, TASK_A, uuid(5));
    expect(h.rowIn(COMPANY_A, GALE_ID)).toBeUndefined();
    expect(h.rowIn(COMPANY_A, WREN_ID)).toBeDefined();
  });
});

describe("a change that does not commit writes no row", () => {
  it("a stale People revision at confirm fails the whole transaction: no row, no new People list", async () => {
    const h = harness();
    await addTaskWebPerson(h.deps, GALE_CALLER, TASK_A, { requestId: uuid(1), expectedPeopleRevision: 3, developerId: WREN_ID, role: "owner" });
    // Someone else changed People after the proposal (the fence moved on).
    h.db.set({ pk: `DEVTASK#${TASK_A}`, sk: "PEOPLE", schemaVersion: 1, revision: 4, orphaned: false, people: [GALE("owner")] });
    await expect(confirmTaskPeopleProposal(h.deps, GALE_CALLER, TASK_A, uuid(1))).rejects.toThrow();
    expect(h.involvedItems()).toEqual([]);
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 4, people: [GALE("owner")] });
  });

  it("a non-owner's change is refused and writes no row", async () => {
    const h = harness({ wrenRegistered: true, people: { revision: 3, orphaned: false, people: [GALE("owner"), WREN("commenter")] } });
    await expect(h.change("owner", 3, 3, WREN_CALLER)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(h.involvedItems()).toEqual([]);
  });
});

describe("taking ownership of an ownerless task", () => {
  it("writes the taker's row, in the task's company", async () => {
    const h = harness({ wrenRegistered: true, people: { revision: 3, orphaned: true, people: [{ ...GALE("denied") }, WREN("commenter")] } });
    await proposeTaskOwnership(h.deps, WREN_CALLER, TASK_A, { requestId: uuid(9), expectedPeopleRevision: 3 });
    await expect(confirmTaskPeopleProposal(h.deps, WREN_CALLER, TASK_A, uuid(9))).resolves.toMatchObject({ status: "COMMITTED" });
    expect(h.rowIn(COMPANY_A, WREN_ID)).toMatchObject({ companyId: COMPANY_A, personId: WREN_ID, taskId: TASK_A });
    expect(h.rowIn(COMPANY_A, GALE_ID)).toBeUndefined();
    expect(h.involvedItems()).toHaveLength(1);
  });
});

describe("the row People writes is the row the readers use", () => {
  /** The stored row, moved into a store the readers can query (the same keys and fields). */
  const readerStore = (h: ReturnType<typeof harness>) => {
    const store = new MemoryDocumentStore();
    return { store, load: async () => { for (const item of h.involvedItems()) await store.put({ item: item as never }); } };
  };

  it("lists the task id for the person in the task's company only, and for nobody else", async () => {
    const h = harness();
    await h.add("owner");
    const { store, load } = readerStore(h);
    await load();
    await expect(involvedTaskIds({ store, companyId: COMPANY_A as never }, { companyId: COMPANY_A, personId: WREN_ID })).resolves.toEqual([TASK_A]);
    await expect(involvedTaskIds({ store, companyId: COMPANY_B as never }, { companyId: COMPANY_B, personId: WREN_ID })).resolves.toEqual([]);
    await expect(involvedTaskIds({ store, companyId: COMPANY_A as never }, { companyId: COMPANY_A, personId: IVY_ID })).resolves.toEqual([]);
    await expect(involvedTaskIds({ store, companyId: COMPANY_A as never }, { companyId: COMPANY_B, personId: WREN_ID })).resolves.toEqual([]);
  });
});
