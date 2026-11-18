// Web task channel, involved wiring: the People commit keeps the person's involved row (`ORG#<company>#INVOLVED#<person>` / `TASK#<createdAt>#<taskId>`, C5) in the SAME transaction as the change.
// An owner after the change has the row (added as owner, promoted, taking ownership); any other role (commenter, viewer, denied) deletes it; the row is in the TASK'S company, never for the task's own
// person, and only for core tasks (a record with a `companyId`). The row grants nothing: the reader re-checks. A change that does not commit writes no row.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type TaskPersonProofRequest, type TaskPersonProofResponse } from "@agentx/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { checkTaskPersonIdentity, listTaskWebCandidates, registerTaskWebPerson, type ProjectAccessSubject, type TaskPersonIdentityDependencies } from "../../packages/broker/src/developer/task-person-identity.js";
import { resolveTaskPeopleAccess } from "../../packages/broker/src/developer/task-people.js";
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
  const moved = new Set<string>();
  const ungranted = new Set<string>();
  const db = new FakeDynamoDb();
  db.set({ ...taskRecord(company), ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }) });
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
    companyMembership: async (developerId) => ({ companyId: moved.has(developerId) ? COMPANY_B : memberOf }),
    projectGrant: async (developerId) => !ungranted.has(developerId),
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
  /** The person leaves the task's company (a member of company B from now on) / loses the project grant. The others are untouched. */
  const leave = (developerId: string) => { moved.add(developerId); };
  const loseGrant = (developerId: string) => { ungranted.add(developerId); };
  return { db, deps, rowKeyOf, rowIn, involvedItems, add, change, leave, loseGrant };
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

describe("an owner the system demotes (they left the company or lost the project) loses their involved row in the same commit", () => {
  const seedOwners = async (h: ReturnType<typeof harness>) => {
    await h.add("owner", 1);
    expect(h.rowIn(COMPANY_A, WREN_ID)).toBeDefined();
  };
  const reconcileNow = async (h: ReturnType<typeof harness>, as = GALE_ID) => {
    const task = h.db.get(`DEVTASK#${TASK_A}`, "META") as unknown as DeveloperTaskRecord;
    return resolveTaskPeopleAccess(h.deps, task, as);
  };

  it("deletes the row when the owner is no longer a member of the task's company (denied), together with the new People revision", async () => {
    const h = harness();
    await seedOwners(h);
    h.leave(WREN_ID);
    await reconcileNow(h);
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 5, people: [GALE("owner"), WREN("denied")] });
    expect(h.rowIn(COMPANY_A, WREN_ID)).toBeUndefined();
    expect(h.involvedItems()).toEqual([]);
  });

  it("deletes the row when the owner lost the project grant (denied)", async () => {
    const h = harness();
    await seedOwners(h);
    h.loseGrant(WREN_ID);
    await reconcileNow(h);
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ people: [GALE("owner"), WREN("denied")] });
    expect(h.rowIn(COMPANY_A, WREN_ID)).toBeUndefined();
  });

  it("deletes the row when the owner is eligible but no longer present (commenter)", async () => {
    const h = harness();
    await seedOwners(h);
    const inner = h.deps.checkTaskPerson!;
    h.deps.checkTaskPerson = async (task, developerId, admission) => {
      const proof = await inner(task, developerId, admission);
      return developerId === WREN_ID ? { ...proof, eligible: true, channelMember: false } : proof;
    };
    await reconcileNow(h);
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ people: [GALE("owner"), WREN("commenter")] });
    expect(h.rowIn(COMPANY_A, WREN_ID)).toBeUndefined();
  });

  it("leaves an unrelated person's involved row alone: only the demoted owner's row goes", async () => {
    const h = harness({ wrenRegistered: true, people: { revision: 3, orphaned: false, people: [GALE("owner"), WREN("owner")] } });
    const ivyRow = { ...h.rowKeyOf(COMPANY_A, IVY_ID), entityType: INVOLVED_ENTITY, companyId: COMPANY_A, personId: IVY_ID, taskId: TASK_A, createdAt: CREATED, addedAt: CREATED };
    h.db.set({ ...h.rowKeyOf(COMPANY_A, WREN_ID), entityType: INVOLVED_ENTITY, companyId: COMPANY_A, personId: WREN_ID, taskId: TASK_A, createdAt: CREATED, addedAt: CREATED });
    h.db.set(ivyRow);
    h.leave(WREN_ID);
    await reconcileNow(h);
    expect(h.rowIn(COMPANY_A, WREN_ID)).toBeUndefined();
    expect(h.rowIn(COMPANY_A, IVY_ID)).toStrictEqual(ivyRow);
  });

  it("leaves a different task's row of the same person alone", async () => {
    const h = harness();
    await seedOwners(h);
    const other = { ...involvedRowKey({ companyId: COMPANY_A, personId: WREN_ID, taskId: uuid(99), createdAt: CREATED }), entityType: INVOLVED_ENTITY, companyId: COMPANY_A, personId: WREN_ID, taskId: uuid(99), createdAt: CREATED, addedAt: CREATED };
    h.db.set(other);
    h.loseGrant(WREN_ID);
    await reconcileNow(h);
    expect(h.rowIn(COMPANY_A, WREN_ID)).toBeUndefined();
    expect(h.db.get(other.pk, other.sk)).toStrictEqual(other);
  });

  it("writes no delete when nothing is demoted (the revision does not move, the row stays)", async () => {
    const h = harness();
    await seedOwners(h);
    await reconcileNow(h);
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 4 });
    expect(h.rowIn(COMPANY_A, WREN_ID)).toBeDefined();
  });

  it("deletes nothing when the People write loses its revision race (row and list never disagree)", async () => {
    const h = harness();
    await seedOwners(h);
    h.loseGrant(WREN_ID);
    // Another writer moves the revision between the read and the write: the transaction's condition fails, so the row must STAY at that moment.
    const send = h.deps.documentClient.send.bind(h.deps.documentClient);
    let raced = false;
    let rowAfterFailedWrite: unknown = "not-checked";
    h.deps.documentClient = { send: async (command: unknown) => {
      if (!raced && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
        raced = true;
        h.db.set({ pk: `DEVTASK#${TASK_A}`, sk: "PEOPLE", schemaVersion: 1, revision: 9, orphaned: false, people: [GALE("owner"), WREN("owner")] });
        try { return await send(command); } finally { rowAfterFailedWrite = h.rowIn(COMPANY_A, WREN_ID); }
      }
      return send(command);
    } };
    await reconcileNow(h);
    expect(raced).toBe(true);
    expect(rowAfterFailedWrite).toBeDefined();
    // The retry reads revision 9 and demotes with its own delete.
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 10 });
    expect(h.rowIn(COMPANY_A, WREN_ID)).toBeUndefined();
  });

  it("demotes a large crowd in passes that fit one transaction (never a failed read), each demoted owner's row deleted with its own pass", async () => {
    const crowd = Array.from({ length: 120 }, (_unused, n) => ({ developerId: ownerKeyForSubject(CLOUD, `crowd-${n}`), name: `Crowd ${String.fromCharCode(97 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}`, role: "owner", method: "cloud" }));
    const h = harness({ people: { revision: 3, orphaned: false, people: [GALE("owner"), ...crowd] } });
    for (const person of crowd) {
      const key = h.rowKeyOf(COMPANY_A, person.developerId);
      h.db.set({ ...key, entityType: INVOLVED_ENTITY, companyId: COMPANY_A, personId: person.developerId, taskId: TASK_A, createdAt: CREATED, addedAt: CREATED });
    }
    const inner = h.deps.checkTaskPerson!;
    h.deps.checkTaskPerson = async (task, developerId, admission) => (developerId === GALE_ID
      ? inner(task, developerId, admission)
      : { subject: { developerId }, identity: { developerId, name: "Crowd", method: "cloud", issuer: CLOUD, subject: "crowd" }, eligible: false, channelMember: false } as never);
    const owners = () => (h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")!.people as Array<{ role: string }>).filter((person) => person.role === "owner").length;
    await expect(reconcileNow(h)).resolves.toBeDefined();
    // The first pass demotes at most 99 (one slot is the People update); the rest are still owners with their rows.
    expect(owners()).toBe(1 + 120 - 99);
    expect(h.involvedItems()).toHaveLength(120 - 99);
    await reconcileNow(h);
    expect(owners()).toBe(1);
    expect(h.involvedItems()).toEqual([]);
  });

  it("never makes a row for the task's own person when they are the one demoted (the other owner's row stays, and no involved item for the creator is in the transaction)", async () => {
    const h = harness({ wrenRegistered: true, people: { revision: 3, orphaned: false, people: [GALE("owner"), WREN("owner")] } });
    h.db.set({ ...h.rowKeyOf(COMPANY_A, WREN_ID), entityType: INVOLVED_ENTITY, companyId: COMPANY_A, personId: WREN_ID, taskId: TASK_A, createdAt: CREATED, addedAt: CREATED });
    const send = h.deps.documentClient.send.bind(h.deps.documentClient);
    const sent: Array<Record<string, { Key?: { pk: string }; Item?: { pk: string } }>> = [];
    h.deps.documentClient = { send: async (command: unknown) => { sent.push(...((command as { input?: { TransactItems?: Array<Record<string, never>> } }).input?.TransactItems ?? [])); return send(command); } };
    h.leave(GALE_ID);
    await reconcileNow(h, WREN_ID);
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ people: [GALE("denied"), WREN("owner")] });
    expect(sent.length).toBeGreaterThan(0);
    const partitions = sent.flatMap((item) => Object.values(item).map((op) => op.Key?.pk ?? op.Item?.pk ?? ""));
    expect(partitions.some((pk) => pk.includes("INVOLVED#"))).toBe(false);
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

describe("the task's own person", () => {
  it("never gets a row for their own task, even when they take the ownerless task back", async () => {
    const h = harness({ people: { revision: 3, orphaned: true, people: [GALE("commenter")] } });
    await proposeTaskOwnership(h.deps, GALE_CALLER, TASK_A, { requestId: uuid(7), expectedPeopleRevision: 3 });
    await expect(confirmTaskPeopleProposal(h.deps, GALE_CALLER, TASK_A, uuid(7))).resolves.toMatchObject({ status: "COMMITTED" });
    expect(h.db.get(`DEVTASK#${TASK_A}`, "PEOPLE")).toMatchObject({ revision: 4, orphaned: false, people: [GALE("owner")] });
    expect(h.involvedItems()).toEqual([]);
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
    await expect(involvedTaskIds({ store, companyId: COMPANY_A }, { companyId: COMPANY_A, personId: WREN_ID })).resolves.toEqual([TASK_A]);
    await expect(involvedTaskIds({ store, companyId: COMPANY_B }, { companyId: COMPANY_B, personId: WREN_ID })).resolves.toEqual([]);
    await expect(involvedTaskIds({ store, companyId: COMPANY_A }, { companyId: COMPANY_A, personId: IVY_ID })).resolves.toEqual([]);
    await expect(involvedTaskIds({ store, companyId: COMPANY_A }, { companyId: COMPANY_B, personId: WREN_ID })).resolves.toEqual([]);
  });
});

describe("the People view says how each person signs in", () => {
  it("gives each person's sign-in method, read from the stored identity, and nothing else of it", async () => {
    const h = harness();
    const committed = await h.add("owner");
    expect(committed.status).toBe("COMMITTED");
    const people = (committed as { view: { people: Array<Record<string, unknown>> } }).view.people;
    expect(people.map((entry) => [entry.name, entry.method])).toEqual([["Gale GitHub", "github"], ["Wren Cloud", "cloud"]]);
    for (const entry of people) expect(Object.keys(entry).sort()).toEqual(["effectiveRole", "method", "name", "personId", "role", "you"]);
    expect(JSON.stringify(people)).not.toContain(CLOUD);
    expect(JSON.stringify(people)).not.toContain("wren-7");
  });

  it("still answers a replay whose stored outcome was written before `method` existed", async () => {
    const h = harness();
    await h.add("commenter", 1);
    const requestRow = h.db.find((item) => String(item.sk).startsWith("PEOPLE_REQUEST#") && item.requestId === uuid(1))[0]!;
    const outcome = requestRow.outcome as { people: Array<Record<string, unknown>> };
    const older = { ...requestRow, outcome: { ...outcome, people: outcome.people.map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "method"))) } };
    h.db.set(older);
    await expect(confirmTaskPeopleProposal(h.deps, GALE_CALLER, TASK_A, uuid(1))).resolves.toMatchObject({ status: "COMMITTED" });
  });

  it("refuses a stored outcome with a method that is not a built-in one (a damaged row reads as no outcome, never a guess)", async () => {
    const h = harness();
    await h.add("commenter", 1);
    const requestRow = h.db.find((item) => String(item.sk).startsWith("PEOPLE_REQUEST#") && item.requestId === uuid(1))[0]!;
    const outcome = requestRow.outcome as { people: Array<Record<string, unknown>> };
    h.db.set({ ...requestRow, outcome: { ...outcome, people: outcome.people.map((entry) => ({ ...entry, method: "mystery" })) } });
    await expect(confirmTaskPeopleProposal(h.deps, GALE_CALLER, TASK_A, uuid(1))).rejects.toThrow();
  });
});
