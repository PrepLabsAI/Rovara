// DEC 254zzz84 (5): removing a member WITH an ownership hand-over (company-member-routes.ts, company-member-handover.ts, task-people.ts taskOwnershipHandOverSteps), through the
// real route, T3b's real member helper, operator and sign-in store (the removal's fences run in its transaction), and a fake DynamoDB. Two companies throughout.
// What it holds: only an owner or admin removes, never themselves; the successor is a live member of the same company; the person's agents, chains and open tasks move to
// the successor in ONE transaction with the removal record and the audit record; a task the successor cannot own is left (counted), never handed over; the request id makes
// it idempotent; the role seen and the successor are fenced at the commit; the last owner is never removed; a hand-over too big for one transaction is refused first.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentXError, agentDirectoryKey, agentKey, chainDirectoryKey, chainKey } from "@agentx/contracts";
import { DocumentAuditSink, auditEventOfRow, auditRowKey } from "@agentx/local-adapters";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { companyMemberActionsThroughLambda } from "../../packages/broker/src/aws/company-member-forwarding.js";
import {
  HANDOVER_UNFINISHED, MEMBERS_UNAVAILABLE, NOT_FOUND, OWN_MEMBERSHIP, PREVIEW_QUERY, REMOVAL_CHANGED, REQUEST_REUSED, SUCCESSOR_INVALID, TOO_MUCH_WORK, routeCompanyMembers,
  type CompanyMemberRouteContext,
} from "../../packages/broker/src/aws/company-member-routes.js";
import { HANDOVER_LIMITS, HANDOVER_TOO_BIG, memberRemovalKey } from "../../packages/broker/src/aws/company-member-handover.js";
import { grantKeyFor, projectMemberRowKeyFor } from "../../packages/broker/src/aws/company-layout.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { MEMBER_LAST_OWNER, MEMBER_REVOKED } from "../../packages/broker/src/developer/company-member-contract.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const OWNER = "a".repeat(64), ADMIN = "b".repeat(64), LEAVER = "c".repeat(64), PEER = "d".repeat(64), OTHER = "e".repeat(64), OWNER2 = "1".repeat(64);
const NAMES: Record<string, string> = { [OWNER]: "Olive", [ADMIN]: "Ada", [LEAVER]: "Lee", [PEER]: "Pat", [OTHER]: "Bea", [OWNER2]: "Oona" };
const CANARY = "leak-canary-84";
const TASK1 = "11111111-1111-4111-8111-111111111111", TASK2 = "22222222-2222-4222-8222-222222222222", TASK3 = "33333333-3333-4333-8333-333333333333";
const MEMBERS = "/v1/dev/company/members";
const refusal = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
const identity = (developerId: string) => ({ developerId, name: NAMES[developerId]!, method: "oidc" as const, issuer: "https://idp.example.test", subject: `sub-${developerId.slice(0, 6)}` });

function world(options: { tasks?: boolean } = {}) {
  const db = new FakeDynamoDb({ seed: 84 });
  const join = (id: string, companyId: string, role: "owner" | "admin" | "member", extra: Record<string, unknown> = {}) => {
    db.set({ ...membershipKey(id), entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role, joinedAt: TIME, ...extra });
    db.set({ pk: `ORG#${companyId}#MEMBERS`, sk: `MEMBER#${id}`, entityType: "COMPANY_MEMBER_VIEW", personId: id, companyId, role, joinedAt: TIME, ...extra });
  };
  for (const id of Object.keys(NAMES)) db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "slack", displayName: NAMES[id], revoked: false });
  join(OWNER, A, "owner"); join(ADMIN, A, "admin"); join(LEAVER, A, "member"); join(PEER, A, "member"); join(OTHER, B, "admin");
  const store = new CompanySignInStore({ documentClient: db, tableName: "SignIn", now: () => NOW });
  const forwarded: Array<Record<string, unknown>> = [];
  const invoke = async (payload: Uint8Array) => {
    const event = JSON.parse(Buffer.from(payload).toString()) as Record<string, unknown>; forwarded.push(event);
    return { Payload: Buffer.from(JSON.stringify(await companyOperator({ store, now: () => NOW, log: () => {} }, event))) };
  };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  // Who may own each task now (a live member with a live grant on its project): the task proof, faked per person.
  const canOwn = new Set<string>([ADMIN, PEER, OWNER]);
  const registered: Array<[string, string]> = [];
  const ctx: CompanyMemberRouteContext = {
    documentClient: db, tableName: "State", signInTableName: "SignIn", now: () => NOW,
    members: companyMemberActionsThroughLambda({ documentClient: db, tableName: "SignIn", invoke }),
    projectsInCompany: async (names) => new Set(names),
    ...(options.tasks === false ? {} : { taskHandOver: {
      deps: {
        documentClient: db, tableName: "State", now: () => NOW, taskPeopleConfiguration: { peopleChangesEnabled: true },
        checkTaskPerson: async (_task, developerId) => ({ subject: { developerId }, identity: identity(developerId), eligible: canOwn.has(developerId), channelMember: canOwn.has(developerId) }),
      },
      register: async (task: DeveloperTaskRecord, developerId: string) => {
        if (!canOwn.has(developerId)) throw new Error("not registrable");
        registered.push([task.taskId, developerId]);
        if (db.get(`DEVTASK#${task.taskId}`, `PERSON_SUBJECT#${developerId}`) !== undefined) return;
        const personId = randomUUID();
        db.set({ pk: `DEVTASK#${task.taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, ...identity(developerId), createdAt: TIME });
        db.set({ pk: `DEVTASK#${task.taskId}`, sk: `PERSON_SUBJECT#${developerId}`, schemaVersion: 1, personId, developerId, createdAt: TIME });
      },
    } }),
  };
  let caller = ADMIN;
  const as = (id: string) => { caller = id; };
  const call = async (method: string, path: string, body?: unknown) => {
    const request = { method, path, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const companyId = (db.get(membershipKey(caller).pk, "COMPANY") as { companyId?: string } | undefined)?.companyId ?? A;
    try {
      return { status: 200, body: await routeCompanyMembers(ctx, { caller: { developerId: caller, sessionId: `s-${caller.slice(0, 4)}`, amr: "slack", name: NAMES[caller]! }, companyId }, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> };
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } as Record<string, unknown> };
    }
  };
  const remove = (id: string, body: Record<string, unknown>) => call("POST", `${MEMBERS}/${id}/removal`, body);
  const preview = (id: string, successor?: string) => call("GET", `${MEMBERS}/${id}/removal-preview${successor === undefined ? "" : `?successorId=${successor}`}`);
  const revoked = (id: string) => (db.get(membershipKey(id).pk, "COMPANY") as { revokedAt?: string } | undefined)?.revokedAt !== undefined;

  // What a person can own: custom agents and chains (META + directory row), and tasks (META, the person's index row, a People list).
  const agent = (companyId: string, id: string, owner: string) => {
    db.set({ ...agentDirectoryKey(companyId, id), entityType: "AGENT_DIRECTORY", orgId: companyId, agentId: id });
    db.set({ ...agentKey(companyId, id, "META"), entityType: "AGENT", orgId: companyId, agentId: id, name: id, owner: { kind: "member", developerId: owner }, status: "active", updatedAt: TIME });
  };
  const chain = (companyId: string, id: string, owner: string) => {
    db.set({ ...chainDirectoryKey(companyId, id), entityType: "CHAIN_DIRECTORY", orgId: companyId, chainId: id });
    db.set({ ...chainKey(companyId, id, "META"), entityType: "CHAIN", orgId: companyId, chainId: id, name: id, owner: { kind: "member", developerId: owner }, status: "active", updatedAt: TIME });
  };
  const task = (taskId: string, extra: Record<string, unknown> = {}, people: Array<[string, string]> = [[LEAVER, "owner"]]) => {
    db.set({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, developerId: LEAVER, companyId: A, project: "alpha", createdAt: TIME, workflow: { revision: 3, stage: "PLAN_REVIEW", state: "WAITING" }, ...extra });
    db.set({ pk: `DEVELOPER#${LEAVER}`, sk: `TASK#${TIME}#${taskId}`, entityType: "DEVELOPER_TASK_INDEX", taskId, status: "RUNNING" });
    db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: people.map(([developerId, role]) => ({ developerId, name: NAMES[developerId], role, method: "oidc" })) });
  };
  const ownerOf = (key: { pk: string; sk: string }) => ((db.get(key.pk, key.sk) as { owner?: { developerId?: string } } | undefined)?.owner?.developerId);
  const people = (taskId: string) => db.get(`DEVTASK#${taskId}`, "PEOPLE") as { revision: number; orphaned: boolean; people: Array<{ developerId: string; role: string }> } | undefined;
  const record = (companyId: string, removalId: string) => { const key = memberRemovalKey(companyId, removalId); return db.get(key.pk, key.sk) as Record<string, unknown> | undefined; };
  const audits = (companyId: string) => db.find((item) => item.pk === `ORG#${companyId}#AUDIT`);
  return { db, ctx, as, call, remove, preview, revoked, join, forwarded, agent, chain, task, ownerOf, people, record, audits, canOwn, registered };
}

describe("the hand-over moves what the person owned, in one transaction, with the record and the audit", () => {
  it("agents, chains and open tasks move to the successor; the membership ends; the record is DONE; one audit record", async () => {
    const h = world();
    h.agent(A, "agt_one", LEAVER); h.agent(A, "agt_peer", PEER); h.chain(A, "chn_one", LEAVER);
    h.task(TASK1); h.task(TASK2, {}, [[LEAVER, "owner"], [OWNER, "commenter"]]);
    const requestId = randomUUID();
    const answer = await h.remove(LEAVER, { requestId, expectedRole: "member", successorId: PEER });
    expect(answer).toEqual({ status: 200, body: { removalId: requestId, state: "DONE", successorId: PEER, moved: { agents: 1, chains: 1, projects: 0, tasks: 2, tasksLeft: 0 } } });
    expect(h.revoked(LEAVER)).toBe(true);
    expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(PEER);
    expect(h.ownerOf(agentKey(A, "agt_peer", "META"))).toBe(PEER);
    expect(h.ownerOf(chainKey(A, "chn_one", "META"))).toBe(PEER);
    for (const taskId of [TASK1, TASK2]) {
      const list = h.people(taskId)!;
      expect(list.orphaned).toBe(false); expect(list.revision).toBe(2);
      expect(list.people.find((p) => p.developerId === LEAVER)?.role).toBe("denied");
      expect(list.people.find((p) => p.developerId === PEER)?.role).toBe("owner");
      expect(h.db.get(`DEVTASK#${taskId}`, `PEOPLE_EVENT#${requestId}`)).toMatchObject({ actorDeveloperId: ADMIN, targetDeveloperId: PEER, afterRole: "owner" });
      // The successor finds the task in their "involved" list.
      expect(h.db.get(`ORG#${A}#INVOLVED#${PEER}`, `TASK#${TIME}#${taskId}`)).toMatchObject({ personId: PEER, taskId });
    }
    expect(h.people(TASK2)!.people.find((p) => p.developerId === OWNER)?.role).toBe("commenter");
    expect(h.record(A, requestId)).toMatchObject({ state: "DONE", leaverId: LEAVER, successorId: PEER, by: ADMIN, expectedRole: "member", moved: { agents: 1, chains: 1, projects: 0, tasks: 2, tasksLeft: 0 } });
    const audit = h.audits(A);
    expect(audit).toHaveLength(1);
    expect(auditEventOfRow(audit[0] as never)).toMatchObject({ action: "member.removed", actor: { type: "person", id: ADMIN }, subject: { type: "person", id: LEAVER },
      details: { successor: PEER, role: "member", agents: 1, chains: 1, tasks: 2, tasksLeft: 0 } });
    expect(h.forwarded).toEqual([{ kind: "company-member-revoke", companyId: A, personId: LEAVER, expectedRole: "member", successorId: PEER, createdBy: ADMIN }]);
  });

  it("the audit row is exactly the row Code's own audit sink writes for the same event", async () => {
    const h = world();
    const requestId = randomUUID();
    await h.remove(LEAVER, { requestId, expectedRole: "member" });
    const row = h.audits(A)[0]!;
    const event = auditEventOfRow(row as never)!;
    const memory = new MemoryDocumentStore();
    await new DocumentAuditSink({ store: () => memory }).record(event);
    const expected = await memory.get(auditRowKey(A, event.eventId));
    expect(row).toEqual(expect.objectContaining(expected as Record<string, unknown>));
  });

  it("the successor defaults to the remover", async () => {
    const h = world(); h.agent(A, "agt_one", LEAVER);
    const answer = await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member" });
    expect(answer.body["successorId"]).toBe(ADMIN);
    expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(ADMIN);
  });

  it("a task the successor cannot own now is left (counted), never handed to them; the rest still moves", async () => {
    const h = world(); h.canOwn.delete(PEER);
    h.agent(A, "agt_one", LEAVER); h.task(TASK1);
    const answer = await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER });
    expect(answer.body["moved"]).toEqual({ agents: 1, chains: 0, projects: 0, tasks: 0, tasksLeft: 1 });
    expect(h.people(TASK1)!.people).toEqual([expect.objectContaining({ developerId: LEAVER, role: "owner" })]);
    expect(h.db.get(`DEVTASK#${TASK1}`, `PERSON_SUBJECT#${PEER}`)).toBeUndefined();
    expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(PEER);
  });

  it("tasks that are closed, of another company, not theirs to own, or with no People list are not handed over", async () => {
    const h = world();
    h.task(TASK1, { closedAt: TIME }); h.task(TASK2, { companyId: B }); h.task(TASK3, {}, [[LEAVER, "commenter"], [OWNER, "owner"]]);
    const answer = await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER });
    expect(answer.body["moved"]).toEqual({ agents: 0, chains: 0, projects: 0, tasks: 0, tasksLeft: 0 });
    for (const taskId of [TASK1, TASK2, TASK3]) expect(h.people(taskId)!.revision, taskId).toBe(1);
    const legacy = world(); legacy.task(TASK1); legacy.db.delete(`DEVTASK#${TASK1}`, "PEOPLE");
    expect((await legacy.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER })).body["moved"]).toEqual({ agents: 0, chains: 0, projects: 0, tasks: 0, tasksLeft: 1 });
  });

  it("a deployment without developer tasks hands over agents and chains and counts the open tasks as left", async () => {
    const h = world({ tasks: false }); h.agent(A, "agt_one", LEAVER); h.task(TASK1);
    expect((await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER })).body["moved"]).toEqual({ agents: 1, chains: 0, projects: 0, tasks: 0, tasksLeft: 1 });
    expect(h.people(TASK1)!.revision).toBe(1);
  });
});

describe("projects the person administers (company layout keys, DEC 254zzz80)", () => {
  const grant = (h: ReturnType<typeof world>, companyId: string, person: string, project: string, role: string, extra: Record<string, unknown> = {}) => {
    h.db.set({ ...grantKeyFor(companyId, person, project), entityType: "MEMBERSHIP", ownerKey: person, projectName: project, role, grantId: randomUUID(), grantedAt: TIME, companyId, ...extra });
    h.db.set({ ...projectMemberRowKeyFor(companyId, project, person), entityType: "PROJECT_MEMBER", role, grantedAt: TIME, companyId });
  };
  const roleOn = (h: ReturnType<typeof world>, companyId: string, person: string, project: string) => { const key = grantKeyFor(companyId, person, project); return (h.db.get(key.pk, key.sk) as { role?: string } | undefined)?.role; };
  const reverseOn = (h: ReturnType<typeof world>, companyId: string, person: string, project: string) => { const key = projectMemberRowKeyFor(companyId, project, person); return (h.db.get(key.pk, key.sk) as { role?: string } | undefined)?.role; };

  it("the successor becomes administrator (new grant, or their developer grant raised); the person's administrator grants go; a developer grant of theirs is not handed over", async () => {
    const h = world();
    grant(h, A, LEAVER, "alpha", "administrator"); grant(h, A, LEAVER, "beta", "administrator"); grant(h, A, PEER, "beta", "developer");
    grant(h, A, LEAVER, "gamma", "developer"); grant(h, A, LEAVER, "delta", "administrator"); grant(h, A, PEER, "delta", "administrator");
    const answer = await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER });
    expect(answer.body["moved"]).toMatchObject({ projects: 3 });
    for (const project of ["alpha", "beta", "delta"]) {
      expect(roleOn(h, A, PEER, project), project).toBe("administrator"); expect(reverseOn(h, A, PEER, project), project).toBe("administrator");
      expect(roleOn(h, A, LEAVER, project), project).toBeUndefined(); expect(reverseOn(h, A, LEAVER, project), project).toBeUndefined();
    }
    expect(roleOn(h, A, PEER, "gamma")).toBeUndefined(); expect(roleOn(h, A, LEAVER, "gamma")).toBe("developer");
    expect(h.db.get(grantKeyFor(A, PEER, "alpha").pk, grantKeyFor(A, PEER, "alpha").sk)).toMatchObject({ entityType: "MEMBERSHIP", ownerKey: PEER, projectName: "alpha", companyId: A });
  });

  it("another company's grants, and a row under the successor's key that names another company, are never moved or overwritten", async () => {
    const h = world();
    grant(h, B, LEAVER, "alpha", "administrator");
    grant(h, A, LEAVER, "beta", "administrator");
    h.db.set({ ...grantKeyFor(A, PEER, "beta"), entityType: "MEMBERSHIP", ownerKey: PEER, projectName: "beta", role: "developer", companyId: B });
    // A row in A's partition that names company B is not A's grant.
    grant(h, A, LEAVER, "omega", "administrator", { companyId: B });
    const answer = await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER });
    expect(answer.body["moved"]).toMatchObject({ projects: 0 });
    expect(roleOn(h, B, LEAVER, "alpha")).toBe("administrator"); expect(roleOn(h, B, PEER, "alpha")).toBeUndefined();
    expect(roleOn(h, A, LEAVER, "beta")).toBe("administrator"); expect(roleOn(h, A, PEER, "beta")).toBe("developer");
    expect(roleOn(h, A, LEAVER, "omega")).toBe("administrator"); expect(roleOn(h, A, PEER, "omega")).toBeUndefined();
  });

  it("the preview counts the projects that would move", async () => {
    const h = world(); grant(h, A, LEAVER, "alpha", "administrator");
    expect((await h.preview(LEAVER, PEER)).body["handOver"]).toMatchObject({ projects: 1 });
    expect(roleOn(h, A, PEER, "alpha")).toBeUndefined();
  });
});

describe("two companies", () => {
  it("another company's admin can neither preview nor remove A's member; nothing moves", async () => {
    const h = world(); h.agent(A, "agt_one", LEAVER); h.as(OTHER);
    expect((await h.preview(LEAVER)).status).toBe(404);
    expect((await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member" })).status).toBe(404);
    expect(h.revoked(LEAVER)).toBe(false); expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(LEAVER); expect(h.forwarded).toEqual([]);
  });

  it("rows of another company that name the person are never moved, even under the same ids", async () => {
    const h = world();
    h.agent(A, "agt_one", LEAVER); h.agent(B, "agt_one", LEAVER); h.chain(B, "chn_b", LEAVER);
    // A row in A's directory whose META claims company B is not A's to move.
    h.db.set({ ...agentDirectoryKey(A, "agt_forged"), entityType: "AGENT_DIRECTORY", orgId: A, agentId: "agt_forged" });
    h.db.set({ ...agentKey(A, "agt_forged", "META"), entityType: "AGENT", orgId: B, agentId: "agt_forged", owner: { kind: "member", developerId: LEAVER } });
    const answer = await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER });
    expect(answer.body["moved"]).toMatchObject({ agents: 1, chains: 0 });
    expect(h.ownerOf(agentKey(B, "agt_one", "META"))).toBe(LEAVER);
    expect(h.ownerOf(chainKey(B, "chn_b", "META"))).toBe(LEAVER);
    expect(h.ownerOf(agentKey(A, "agt_forged", "META"))).toBe(LEAVER);
    expect(h.audits(B)).toEqual([]);
  });

  it("a successor from another company is refused like a missing one, and nothing happens", async () => {
    const h = world(); h.agent(A, "agt_one", LEAVER);
    for (const successorId of [OTHER, "f".repeat(64), LEAVER]) {
      expect(await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId })).toEqual(refusal(409, "SUCCESSOR_INVALID", SUCCESSOR_INVALID));
      expect(await h.preview(LEAVER, successorId)).toEqual(refusal(409, "SUCCESSOR_INVALID", SUCCESSOR_INVALID));
    }
    expect(h.revoked(LEAVER)).toBe(false); expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(LEAVER); expect(h.forwarded).toEqual([]);
  });
});

describe("who may remove", () => {
  it("a plain member cannot remove or preview anyone; nothing is forwarded or moved", async () => {
    const h = world(); h.agent(A, "agt_one", LEAVER); h.as(PEER);
    expect(await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member" })).toEqual(refusal(404, "NOT_FOUND", NOT_FOUND));
    expect(await h.preview(LEAVER)).toEqual(refusal(404, "NOT_FOUND", NOT_FOUND));
    expect(h.revoked(LEAVER)).toBe(false); expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(LEAVER); expect(h.forwarded).toEqual([]);
  });

  it("nobody removes themselves here", async () => {
    const h = world();
    expect(await h.remove(ADMIN, { requestId: randomUUID(), expectedRole: "admin", successorId: OWNER })).toEqual(refusal(403, "FORBIDDEN", OWN_MEMBERSHIP));
    expect(h.revoked(ADMIN)).toBe(false);
  });

  it("an owner removes an admin; an admin removes an admin", async () => {
    const h = world(); h.join(PEER, A, "admin");
    expect((await h.remove(PEER, { requestId: randomUUID(), expectedRole: "admin" })).status).toBe(200);
    expect(h.revoked(PEER)).toBe(true);
    h.as(OWNER);
    expect((await h.remove(ADMIN, { requestId: randomUUID(), expectedRole: "admin" })).status).toBe(200);
    expect(h.revoked(ADMIN)).toBe(true);
  });
});

describe("the last owner and the fences", () => {
  it("the company's last owner is never removed: the identity side's witness refuses it inside its transaction, and nothing moves", async () => {
    const h = world(); h.join(OWNER2, A, "owner"); h.as(OWNER2); h.agent(A, "agt_owner", OWNER);
    // The identity side finds no OTHER live owner to witness (its member list no longer shows the caller as one): it refuses rather than leave the company with none.
    h.db.set({ ...h.db.get(`ORG#${A}#MEMBERS`, `MEMBER#${OWNER2}`)!, role: "admin" });
    const requestId = randomUUID();
    expect(await h.remove(OWNER, { requestId, expectedRole: "owner", successorId: ADMIN })).toEqual(refusal(409, "LAST_OWNER", MEMBER_LAST_OWNER));
    expect(h.revoked(OWNER)).toBe(false); expect(h.ownerOf(agentKey(A, "agt_owner", "META"))).toBe(OWNER);
    expect(h.record(A, requestId)).toBeUndefined();
    expect(h.audits(A)).toEqual([]);
  });

  it("the store refuses to remove a sole owner even for an operator naming a successor", async () => {
    const h = world();
    const store = new CompanySignInStore({ documentClient: h.db, tableName: "SignIn", now: () => NOW });
    await expect(store.setRevoked(A, OWNER, true, undefined, { expectedRole: "owner", successorId: ADMIN })).rejects.toMatchObject({ response: { message: MEMBER_LAST_OWNER } });
    expect(h.revoked(OWNER)).toBe(false);
  });

  it("a role that is not the one the remover saw is refused, at the route and inside the transaction", async () => {
    const h = world(); h.agent(A, "agt_one", LEAVER);
    expect(await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "admin" })).toEqual(refusal(409, "CHANGE_STALE", REMOVAL_CHANGED));
    // The role changes between the route's read and the identity side's write.
    const helper = h.ctx.members;
    h.ctx.members = { ...helper, revoke: async (caller, request) => { h.join(LEAVER, A, "admin"); return helper.revoke(caller, request); } };
    expect(await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member" })).toEqual(refusal(409, "CHANGE_STALE", REMOVAL_CHANGED));
    expect(h.revoked(LEAVER)).toBe(false); expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(LEAVER);
  });

  it("a successor removed between the route's read and the identity side's write is refused inside the transaction", async () => {
    const h = world(); h.agent(A, "agt_one", LEAVER);
    const helper = h.ctx.members;
    h.ctx.members = { ...helper, revoke: async (caller, request) => { h.join(PEER, A, "member", { revokedAt: TIME }); return helper.revoke(caller, request); } };
    expect(await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER })).toEqual(refusal(409, "SUCCESSOR_INVALID", SUCCESSOR_INVALID));
    expect(h.revoked(LEAVER)).toBe(false); expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(LEAVER);
  });
});

describe("the request id", () => {
  it("a repeat of the same request answers DONE again and moves nothing twice", async () => {
    const h = world(); h.agent(A, "agt_one", LEAVER); h.task(TASK1);
    const body = { requestId: randomUUID(), expectedRole: "member", successorId: PEER };
    const first = await h.remove(LEAVER, body);
    const revision = h.people(TASK1)!.revision;
    expect(await h.remove(LEAVER, body)).toEqual(first);
    expect(await h.remove(LEAVER, { ...body, requestId: body.requestId.toUpperCase() })).toEqual(first);
    expect(h.people(TASK1)!.revision).toBe(revision); expect(h.audits(A)).toHaveLength(1);
    expect(h.forwarded.filter((event) => event["kind"] === "company-member-revoke")).toHaveLength(1);
  });

  it("the same request id for another removal is refused in fixed words", async () => {
    const h = world();
    const requestId = randomUUID();
    await h.remove(LEAVER, { requestId, expectedRole: "member", successorId: PEER });
    expect(await h.remove(LEAVER, { requestId, expectedRole: "member", successorId: OWNER })).toEqual(refusal(409, "IDEMPOTENCY_CONFLICT", REQUEST_REUSED));
    h.as(OWNER);
    expect(await h.remove(LEAVER, { requestId, expectedRole: "member", successorId: PEER })).toEqual(refusal(409, "IDEMPOTENCY_CONFLICT", REQUEST_REUSED));
  });

  it("a hand-over that did not finish after the membership ended is finished by the same request, and only by it", async () => {
    const h = world(); h.agent(A, "agt_one", LEAVER); h.task(TASK1);
    const body = { requestId: randomUUID(), expectedRole: "member", successorId: PEER };
    // Every hand-over commit fails (the transaction cancels) until healed.
    const send = h.db.send.bind(h.db);
    let broken = true;
    h.db.send = (async (command: { constructor: { name: string }; input: { TransactItems?: Array<Record<string, { Key?: { pk?: string } }>> } }) => {
      const finishing = command.constructor.name === "TransactWriteCommand" && command.input.TransactItems?.some((item) => item["Update"]?.Key?.pk === `ORG#${A}#MEMBER_REMOVAL`);
      if (broken && finishing) throw Object.assign(new Error(CANARY), { name: "TransactionCanceledException" });
      return send(command);
    });
    const failed = await h.remove(LEAVER, body);
    expect(failed).toEqual(refusal(503, "RUNTIME_UNAVAILABLE", HANDOVER_UNFINISHED));
    expect(JSON.stringify(failed)).not.toContain(CANARY);
    expect(h.revoked(LEAVER)).toBe(true); expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(LEAVER);
    // Another request id sees an ended membership and does not take over the hand-over.
    expect(await h.remove(LEAVER, { ...body, requestId: randomUUID() })).toEqual(refusal(409, "MEMBER_ALREADY_REMOVED", MEMBER_REVOKED));
    broken = false;
    expect(await h.remove(LEAVER, body)).toMatchObject({ status: 200, body: { state: "DONE", moved: { agents: 1, chains: 0, projects: 0, tasks: 1, tasksLeft: 0 } } });
    expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(PEER);
    expect(h.forwarded.filter((event) => event["kind"] === "company-member-revoke")).toHaveLength(1);
  });

  it("a row that changes during the hand-over cancels the whole commit; the hand-over plans again and moves everything once", async () => {
    const h = world(); h.agent(A, "agt_one", LEAVER); h.agent(A, "agt_two", LEAVER);
    const send = h.db.send.bind(h.db);
    let raced = false;
    h.db.send = (async (command: { constructor: { name: string }; input: { TransactItems?: Array<Record<string, { Key?: { pk?: string } }>> } }) => {
      const finishing = command.constructor.name === "TransactWriteCommand" && command.input.TransactItems?.some((item) => item["Update"]?.Key?.pk === `ORG#${A}#MEMBER_REMOVAL`);
      // Just before the first commit, someone else takes over one agent: that step's condition fails, so NOTHING of the first commit applies.
      if (finishing && !raced) { raced = true; h.agent(A, "agt_two", OWNER); }
      return send(command);
    });
    const answer = await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER });
    expect(answer.body["moved"]).toEqual({ agents: 1, chains: 0, projects: 0, tasks: 0, tasksLeft: 0 });
    expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(PEER); expect(h.ownerOf(agentKey(A, "agt_two", "META"))).toBe(OWNER);
    expect(h.audits(A)).toHaveLength(1);
  });
});

describe("a STARTED record ends a membership only as its own prompt retry (review M1)", () => {
  it("an old STARTED record never ends a live membership (the person was restored or rejoined since)", async () => {
    const h = world();
    const requestId = randomUUID();
    h.db.set({ ...memberRemovalKey(A, requestId), entityType: "COMPANY_MEMBER_REMOVAL", companyId: A, removalId: requestId, leaverId: LEAVER, successorId: ADMIN, expectedRole: "member", by: ADMIN,
      startedAt: new Date(NOW - 16 * 60_000).toISOString(), state: "STARTED" });
    expect(await h.remove(LEAVER, { requestId, expectedRole: "member" })).toEqual(refusal(409, "IDEMPOTENCY_CONFLICT", REQUEST_REUSED));
    expect(h.revoked(LEAVER)).toBe(false); expect(h.forwarded).toEqual([]);
  });

  it("a membership another remover ended is never taken over by this removal's record", async () => {
    const h = world(); h.agent(A, "agt_one", LEAVER);
    const requestId = randomUUID();
    h.db.set({ ...memberRemovalKey(A, requestId), entityType: "COMPANY_MEMBER_REMOVAL", companyId: A, removalId: requestId, leaverId: LEAVER, successorId: ADMIN, expectedRole: "member", by: ADMIN,
      startedAt: new Date(NOW - 60_000).toISOString(), state: "STARTED" });
    h.join(LEAVER, A, "member", { revokedAt: new Date(NOW).toISOString(), revokedBy: OWNER });
    expect(await h.remove(LEAVER, { requestId, expectedRole: "member" })).toEqual(refusal(409, "MEMBER_ALREADY_REMOVED", MEMBER_REVOKED));
    expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(LEAVER); expect(h.audits(A)).toEqual([]);
  });
});

describe("bounds", () => {
  it("open tasks count toward the one transaction BEFORE anyone is removed (review H1)", async () => {
    const h = world();
    for (let i = 0; i < 25; i++) h.task(`${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    expect(await h.preview(LEAVER, PEER)).toEqual(refusal(400, "CONFIG_INVALID", TOO_MUCH_WORK));
    expect(await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER })).toEqual(refusal(400, "CONFIG_INVALID", HANDOVER_TOO_BIG));
    expect(h.revoked(LEAVER)).toBe(false); expect(h.forwarded).toEqual([]); expect(h.registered).toEqual([]);
  });

  it("a hand-over larger than one transaction is refused BEFORE anyone is removed", async () => {
    const h = world();
    for (let i = 0; i < HANDOVER_LIMITS.transactionSteps; i++) h.agent(A, `agt_${String(i).padStart(3, "0")}`, LEAVER);
    expect(await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member" })).toEqual(refusal(400, "CONFIG_INVALID", HANDOVER_TOO_BIG));
    expect(await h.preview(LEAVER)).toEqual(refusal(400, "CONFIG_INVALID", TOO_MUCH_WORK));
    expect(h.revoked(LEAVER)).toBe(false); expect(h.forwarded).toEqual([]);
    expect(h.ownerOf(agentKey(A, "agt_000", "META"))).toBe(LEAVER);
  });
});

describe("the preview", () => {
  it("names the person and the successor and counts what would move, writing nothing", async () => {
    const h = world(); h.agent(A, "agt_one", LEAVER); h.chain(A, "chn_one", LEAVER); h.task(TASK1); h.task(TASK2);
    h.canOwn.delete(OWNER);
    const before = JSON.stringify(h.db.find(() => true));
    const answer = await h.preview(LEAVER, PEER);
    expect(answer.body).toMatchObject({ personId: LEAVER, name: "Lee", role: "member", successor: { personId: PEER, name: "Pat" }, handOver: { agents: 1, chains: 1, projects: 0, tasks: 2, tasksLeft: 0 }, mayRemove: true });
    expect((await h.preview(LEAVER, OWNER)).body["handOver"]).toEqual({ agents: 1, chains: 1, projects: 0, tasks: 0, tasksLeft: 2 });
    expect((await h.preview(LEAVER)).body["successor"]).toEqual({ personId: ADMIN, name: "Ada" });
    expect(JSON.stringify(h.db.find(() => true))).toBe(before);
    expect(h.registered).toEqual([]);
  });

  it("takes only an optional successorId and never echoes the query", async () => {
    const h = world();
    for (const query of [`?${CANARY}=1`, `?successorId=${PEER}&successorId=${PEER}`, `?successorId=${PEER}&x=1`]) {
      const answer = await h.call("GET", `${MEMBERS}/${LEAVER}/removal-preview${query}`);
      expect(answer).toEqual(refusal(400, "CONFIG_INVALID", PREVIEW_QUERY));
    }
    const answer = await h.preview(LEAVER, CANARY);
    expect(answer).toEqual(refusal(409, "SUCCESSOR_INVALID", SUCCESSOR_INVALID));
    expect(JSON.stringify(answer)).not.toContain(CANARY);
  });

  it("a removal record that does not read refuses in fixed words, never treated as absent", async () => {
    const h = world();
    const requestId = randomUUID();
    const key = memberRemovalKey(A, requestId);
    h.db.set({ ...key, entityType: "COMPANY_MEMBER_REMOVAL", leaverId: CANARY });
    const answer = await h.remove(LEAVER, { requestId, expectedRole: "member" });
    expect(answer).toEqual(refusal(503, "RUNTIME_UNAVAILABLE", MEMBERS_UNAVAILABLE));
    expect(h.revoked(LEAVER)).toBe(false);
  });
});
