// DEC 254zzz84 (5): removing a member WITH an ownership hand-over (company-member-routes.ts, company-member-handover.ts, task-people.ts taskOwnershipHandOverSteps), through the
// real route, T3b's real member helper, operator and sign-in store (the removal's fences run in its transaction), and a fake DynamoDB. Two companies throughout.
// What it holds: only an owner or admin removes, never themselves; the successor is a live member of the same company; the person's agents, chains and open tasks move to
// the successor in ONE transaction with the removal record and the audit record; a task the successor cannot own is left (counted), never handed over; the request id makes
// it idempotent; the role seen and the successor are fenced at the commit; the last owner is never removed; a hand-over too big for one transaction is refused first.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentXError, ON_THE_WEBSITE_MESSAGE, agentDirectoryKey, agentKey, chainDirectoryKey, chainKey } from "@agentx/contracts";
import { auditEventOfRow } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { companyMemberActionsThroughLambda } from "../../packages/broker/src/aws/company-member-forwarding.js";
import { FINISH_BODY, HANDOVER_IN_PROGRESS, HANDOVER_UNFINISHED, MEMBERS_UNAVAILABLE, MEMBER_NOT_FOUND, NO_PENDING_HANDOVER, NOT_FOUND, OWNER_ONLY, PREVIEW_QUERY, REMOVAL_CHANGED, REQUEST_REUSED, SUCCESSOR_INVALID, TOO_MUCH_WORK, routeCompanyMembers, type CompanyMemberRouteContext } from "../../packages/broker/src/aws/company-member-routes.js";
import { HANDOVER_LIMITS, HANDOVER_TOO_BIG, memberRemovalKey, pendingHandOverKey } from "../../packages/broker/src/aws/company-member-handover.js";
import { grantKeyFor, projectMemberRowKeyFor } from "../../packages/broker/src/aws/company-layout.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { MEMBER_REVOKED } from "../../packages/broker/src/developer/company-member-contract.js";
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
  let caller = ADMIN, webApp = true;
  const as = (id: string) => { caller = id; };
  /** DEC 254zzz91: a change from a client other than the Rovara website's own (the CLI's token, an AI tool's). */
  const fromTool = () => { webApp = false; };
  const call = async (method: string, path: string, body?: unknown) => {
    const request = { method, path, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    const companyId = (db.get(membershipKey(caller).pk, "COMPANY") as { companyId?: string } | undefined)?.companyId ?? A;
    try {
      return { status: 200, body: await routeCompanyMembers(ctx, { caller: { developerId: caller, sessionId: `s-${caller.slice(0, 4)}`, amr: "slack", name: NAMES[caller]! }, companyId, webApp }, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> };
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
  const finish = (id: string, body: Record<string, unknown>) => call("POST", `${MEMBERS}/${id}/handover`, body);
  const pending = () => call("GET", `${MEMBERS}/handovers`);
  return { db, ctx, as, fromTool, finish, pending, call, remove, preview, revoked, join, forwarded, agent, chain, task, ownerOf, people, record, audits, canOwn, registered };
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
  /** A project of a company, where the company layout keeps it (a named company's own partition). */
  const projectOf = (h: ReturnType<typeof world>, companyId: string, project: string) => h.db.set({ pk: `ORG#${companyId}#PROJECT#${project}`, sk: "REV#000000000001", entityType: "PROJECT",
    definition: { name: project, revision: 1, orchestratorInstructions: "x", setup: [{ executable: "npm", args: ["ci"], cwd: "repo/r", timeoutSeconds: 900 }],
      readiness: [{ executable: "npm", args: ["test"], cwd: "repo/r", timeoutSeconds: 900 }], repositories: [{ name: "r", url: "https://github.com/acme/r", defaultBranch: "main", path: "repo/r", credentialRef: "github-agentx-sdlc" }] } });
  const grant = (h: ReturnType<typeof world>, companyId: string, person: string, project: string, role: string, extra: Record<string, unknown> = {}) => {
    projectOf(h, companyId, project);
    h.db.set({ ...grantKeyFor(companyId, person, project), entityType: "MEMBERSHIP", ownerKey: person, projectName: project, role, grantId: randomUUID(), grantedAt: TIME, companyId, ...extra });
    h.db.set({ ...projectMemberRowKeyFor(companyId, project, person), entityType: "PROJECT_MEMBER", role, grantedAt: TIME, companyId });
  };
  const roleOn = (h: ReturnType<typeof world>, companyId: string, person: string, project: string) => { const key = grantKeyFor(companyId, person, project); return (h.db.get(key.pk, key.sk) as { role?: string } | undefined)?.role; };
  const reverseOn = (h: ReturnType<typeof world>, companyId: string, person: string, project: string) => { const key = projectMemberRowKeyFor(companyId, project, person); return (h.db.get(key.pk, key.sk) as { role?: string } | undefined)?.role; };

  it("the successor becomes administrator (new grant, or their developer grant raised); the person's administrator grants go; a developer grant of theirs is not handed over, and goes with them", async () => {
    const h = world();
    grant(h, A, LEAVER, "alpha", "administrator"); grant(h, A, LEAVER, "beta", "administrator"); grant(h, A, PEER, "beta", "developer");
    grant(h, A, LEAVER, "gamma", "developer"); grant(h, A, LEAVER, "delta", "administrator"); grant(h, A, PEER, "delta", "administrator");
    const answer = await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER });
    expect(answer.body["moved"]).toMatchObject({ projects: 3 });
    for (const project of ["alpha", "beta", "delta"]) {
      expect(roleOn(h, A, PEER, project), project).toBe("administrator"); expect(reverseOn(h, A, PEER, project), project).toBe("administrator");
      expect(roleOn(h, A, LEAVER, project), project).toBeUndefined(); expect(reverseOn(h, A, LEAVER, project), project).toBeUndefined();
    }
    // A developer grant is not handed over (the successor gets none), and it goes with the person (arch cleanup, rule 7: company-member-removal-rejoin.test.ts).
    expect(roleOn(h, A, PEER, "gamma")).toBeUndefined(); expect(roleOn(h, A, LEAVER, "gamma")).toBeUndefined(); expect(reverseOn(h, A, LEAVER, "gamma")).toBeUndefined();
    expect(h.db.get(grantKeyFor(A, PEER, "alpha").pk, grantKeyFor(A, PEER, "alpha").sk)).toMatchObject({ entityType: "MEMBERSHIP", ownerKey: PEER, projectName: "alpha", role: "administrator" });
  });

  it("a project whose current revision cannot be read (arch rule 9) does not block the hand-over of the leaver's others: its grants move too", async () => {
    const h = world();
    grant(h, A, LEAVER, "alpha", "administrator"); grant(h, A, LEAVER, "broken", "administrator");
    h.db.set({ pk: `ORG#${A}#PROJECT#broken`, sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "broken", revision: 1 } });
    const answer = await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER });
    expect(answer.body["moved"]).toMatchObject({ projects: 2 });
    for (const project of ["alpha", "broken"]) expect(roleOn(h, A, PEER, project), project).toBe("administrator");
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

});

describe("two companies", () => {

  it("a successor from another company is refused like a missing one, and nothing happens", async () => {
    const h = world(); h.agent(A, "agt_one", LEAVER);
    for (const successorId of [OTHER, "f".repeat(64), LEAVER]) {
      expect(await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId })).toEqual(refusal(409, "SUCCESSOR_INVALID", SUCCESSOR_INVALID));
      expect(await h.preview(LEAVER, successorId)).toEqual(refusal(409, "SUCCESSOR_INVALID", SUCCESSOR_INVALID));
    }
    expect(h.revoked(LEAVER)).toBe(false); expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(LEAVER); expect(h.forwarded).toEqual([]);
  });
});

describe("the last owner and the fences", () => {

  it("the store's own transaction fences the successor: removed after its read, before its write, nothing changes", async () => {
    const h = world();
    const store = new CompanySignInStore({ documentClient: h.db, tableName: "SignIn", now: () => NOW });
    const send = h.db.send.bind(h.db);
    h.db.send = (async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "TransactWriteCommand") h.join(PEER, A, "member", { revokedAt: TIME });
      return send(command as never);
    });
    await expect(store.setRevoked(A, LEAVER, true, ADMIN, { expectedRole: "member", successorId: PEER })).rejects.toMatchObject({ response: { message: SUCCESSOR_INVALID } });
    h.db.send = send;
    expect(h.revoked(LEAVER)).toBe(false);
  });

  it("a role that is not the one the remover saw is refused, at the route and inside the transaction", async () => {
    const h = world(); h.agent(A, "agt_one", LEAVER);
    expect(await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "admin" })).toEqual(refusal(409, "CHANGE_STALE", REMOVAL_CHANGED));
    // The route refuses it itself: nothing is started or forwarded.
    expect(h.forwarded).toEqual([]); expect(h.db.find((item) => item.entityType === "COMPANY_MEMBER_REMOVAL")).toEqual([]);
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

describe("finishing a stuck hand-over (DEC 254zzz101)", () => {
  /** A removal whose successor leaves between the membership's end and the hand-over: the person is removed, nothing moved, the hand-over waits. */
  const stuck = async (h: ReturnType<typeof world>) => {
    h.agent(A, "agt_one", LEAVER); h.task(TASK1);
    const helper = h.ctx.members;
    h.ctx.members = { ...helper, revoke: async (caller, request) => { const answer = await helper.revoke(caller, request); h.join(PEER, A, "member", { revokedAt: TIME }); return answer; } };
    const body = { requestId: randomUUID(), expectedRole: "member", successorId: PEER };
    expect(await h.remove(LEAVER, body)).toEqual(refusal(409, "SUCCESSOR_INVALID", SUCCESSOR_INVALID));
    h.ctx.members = helper;
    expect(h.revoked(LEAVER)).toBe(true); expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(LEAVER);
    // Stuck for a while: anyone with the right role may finish it now (before, only its remover).
    const key = memberRemovalKey(A, body.requestId);
    h.db.set({ ...h.db.get(key.pk, key.sk)!, startedAt: new Date(NOW - 3 * 60_000).toISOString() });
    return body;
  };

  it("lists the stuck hand-over; an owner finishes it to another live member; everything moves once, audited; the pending entry goes", async () => {
    const h = world(); const removal = await stuck(h);
    expect((await h.pending()).body["handovers"]).toEqual([{ personId: LEAVER, name: "Lee", removalId: removal.requestId, startedAt: new Date(NOW - 3 * 60_000).toISOString(), removedBy: ADMIN, successorId: PEER }]);
    h.as(OWNER);
    const requestId = randomUUID();
    const answer = await h.finish(LEAVER, { requestId, successorId: ADMIN });
    expect(answer).toEqual({ status: 200, body: { removalId: removal.requestId, state: "DONE", successorId: ADMIN, moved: { agents: 1, chains: 0, projects: 0, tasks: 1, tasksLeft: 0 } } });
    expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(ADMIN);
    expect(h.people(TASK1)!.people.find((p) => p.developerId === ADMIN)?.role).toBe("owner");
    expect(h.record(A, removal.requestId)).toMatchObject({ state: "DONE", successorId: PEER, handedTo: ADMIN, finishedBy: OWNER, finishRequestId: requestId });
    expect(auditEventOfRow(h.audits(A)[0] as never)).toMatchObject({ actor: { type: "person", id: OWNER }, details: { successor: ADMIN, removedBy: ADMIN, finishedBy: OWNER } });
    expect((await h.pending()).body["handovers"]).toEqual([]);
    // The finish request repeated answers the same; the same id for another successor is refused; the first remover's own retry now answers DONE too.
    expect(await h.finish(LEAVER, { requestId, successorId: ADMIN })).toEqual(answer);
    expect(await h.finish(LEAVER, { requestId, successorId: OWNER })).toEqual(refusal(409, "IDEMPOTENCY_CONFLICT", REQUEST_REUSED));
    h.as(ADMIN);
    expect((await h.remove(LEAVER, removal)).body).toMatchObject({ state: "DONE", successorId: ADMIN });
    expect(h.audits(A)).toHaveLength(1);
    // Back in the company since: the finish request's replay finishes nothing for them now.
    h.as(OWNER); h.join(LEAVER, A, "member");
    expect(await h.finish(LEAVER, { requestId, successorId: ADMIN })).toEqual(refusal(404, "NOT_FOUND", NO_PENDING_HANDOVER));
  });

  it("only from the website, only an owner or admin, only in the person's own company, only for a removed person with a hand-over waiting", async () => {
    const h = world(); await stuck(h);
    const body = () => ({ requestId: randomUUID(), successorId: ADMIN });
    h.fromTool();
    expect(await h.finish(LEAVER, body())).toEqual(refusal(403, "FORBIDDEN", ON_THE_WEBSITE_MESSAGE));
    const web = world(); await stuck(web);
    web.as(OTHER);
    expect(await web.finish(LEAVER, body())).toEqual(refusal(404, "NOT_FOUND", MEMBER_NOT_FOUND));
    expect((await web.pending()).body["handovers"]).toEqual([]);
    web.join(PEER, A, "member"); web.as(PEER);
    expect(await web.finish(LEAVER, body())).toEqual(refusal(404, "NOT_FOUND", NOT_FOUND));
    expect((await web.pending()).status).toBe(404);
    web.as(ADMIN);
    expect(await web.finish(OWNER, body())).toEqual(refusal(404, "NOT_FOUND", NO_PENDING_HANDOVER));
    for (const bad of [{}, { requestId: CANARY, successorId: ADMIN }, { requestId: randomUUID(), successorId: CANARY }, { requestId: randomUUID(), successorId: ADMIN, companyId: B }]) {
      const answer = await web.finish(LEAVER, bad);
      expect(answer).toEqual(refusal(400, "CONFIG_INVALID", FINISH_BODY)); expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    for (const successorId of [OTHER, LEAVER, "f".repeat(64)]) expect(await web.finish(LEAVER, { requestId: randomUUID(), successorId })).toEqual(refusal(409, "SUCCESSOR_INVALID", SUCCESSOR_INVALID));
    expect(web.ownerOf(agentKey(A, "agt_one", "META"))).toBe(LEAVER); expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(LEAVER);
  });

  it("a person back in the company, or a pending row whose removal already finished, has nothing to finish", async () => {
    const h = world(); const removal = await stuck(h);
    h.join(LEAVER, A, "member");
    expect(await h.finish(LEAVER, { requestId: randomUUID(), successorId: ADMIN })).toEqual(refusal(404, "NOT_FOUND", NO_PENDING_HANDOVER));
    expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(LEAVER);
    h.join(LEAVER, A, "member", { revokedAt: TIME, revokedBy: ADMIN });
    expect((await h.finish(LEAVER, { requestId: randomUUID(), successorId: ADMIN })).status).toBe(200);
    // A pending row left pointing at the finished removal is never finished again.
    h.db.set({ ...pendingHandOverKey(A, LEAVER), entityType: "COMPANY_MEMBER_HANDOVER_PENDING", companyId: A, leaverId: LEAVER, removalId: removal.requestId });
    expect(await h.finish(LEAVER, { requestId: randomUUID(), successorId: OWNER })).toEqual(refusal(404, "NOT_FOUND", NO_PENDING_HANDOVER));
    expect(h.ownerOf(agentKey(A, "agt_one", "META"))).toBe(ADMIN);
  });

  it("a removal still being made is its remover's to finish for a few minutes; a person never removed is not listed", async () => {
    const h = world(); const removal = await stuck(h);
    const key = memberRemovalKey(A, removal.requestId);
    h.db.set({ ...h.db.get(key.pk, key.sk)!, startedAt: new Date(NOW - 30_000).toISOString() });
    h.as(OWNER);
    expect(await h.finish(LEAVER, { requestId: randomUUID(), successorId: OWNER })).toEqual(refusal(409, "CHANGE_STALE", HANDOVER_IN_PROGRESS));
    h.as(ADMIN);
    expect((await h.finish(LEAVER, { requestId: randomUUID(), successorId: ADMIN })).status).toBe(200);
    // A STARTED record whose revoke never happened (the person is still a member) is not offered.
    h.db.set({ ...pendingHandOverKey(A, PEER), entityType: "COMPANY_MEMBER_HANDOVER_PENDING", companyId: A, leaverId: PEER, removalId: "99999999-9999-4999-8999-999999999999" });
    h.db.set({ ...memberRemovalKey(A, "99999999-9999-4999-8999-999999999999"), entityType: "COMPANY_MEMBER_REMOVAL", companyId: A, removalId: "99999999-9999-4999-8999-999999999999", leaverId: PEER, successorId: ADMIN, expectedRole: "member", by: ADMIN, startedAt: TIME, state: "STARTED" });
    h.join(PEER, A, "member");
    expect((await h.pending()).body["handovers"]).toEqual([]);
  });

  it("a second removal racing the first never re-stamps an ended membership", async () => {
    const h = world();
    const store = new CompanySignInStore({ documentClient: h.db, tableName: "SignIn", now: () => NOW });
    expect(await store.setRevoked(A, LEAVER, true, ADMIN, { expectedRole: "member", successorId: ADMIN })).toBe(true);
    const before = h.db.get(membershipKey(LEAVER).pk, "COMPANY");
    await expect(store.setRevoked(A, LEAVER, true, OWNER, { expectedRole: "member", successorId: OWNER })).rejects.toMatchObject({ response: { message: MEMBER_REVOKED } });
    expect(h.db.get(membershipKey(LEAVER).pk, "COMPANY")).toEqual(before);
  });

  it("an owner's stuck hand-over is finished only by an owner", async () => {
    const h = world(); h.join(OWNER2, A, "owner"); h.agent(A, "agt_o", OWNER2); h.as(OWNER);
    const helper = h.ctx.members;
    h.ctx.members = { ...helper, revoke: async (caller, request) => { const answer = await helper.revoke(caller, request); h.join(PEER, A, "member", { revokedAt: TIME }); return answer; } };
    expect((await h.remove(OWNER2, { requestId: randomUUID(), expectedRole: "owner", successorId: PEER })).status).toBe(409);
    h.ctx.members = helper;
    h.as(ADMIN);
    expect(await h.finish(OWNER2, { requestId: randomUUID(), successorId: ADMIN })).toEqual(refusal(403, "FORBIDDEN", OWNER_ONLY));
    h.as(OWNER);
    expect((await h.finish(OWNER2, { requestId: randomUUID(), successorId: OWNER })).status).toBe(200);
    expect(h.ownerOf(agentKey(A, "agt_o", "META"))).toBe(OWNER);
  });

});

describe("the workspace slot moves to the successor with each task (TASK-TAKEOVER PR A)", () => {
  const LEAVER_LIMIT = `DEVELOPER_LIMIT#${LEAVER}`, PEER_LIMIT = `DEVELOPER_LIMIT#${PEER}`;
  const taskId = (n: number) => `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const charge = (member: string) => ({ member: { pk: member, sk: "MEMBER" }, organization: { pk: `ORG_LIMIT#${A}`, sk: "ORGANIZATION" } });
  /** An open task of the leaver's that holds a slot of their own counter (the marker row, and the task naming the counter). */
  const slotted = (h: ReturnType<typeof world>, id: string) => {
    h.task(id, { charge: charge(LEAVER_LIMIT) });
    h.db.set({ pk: LEAVER_LIMIT, sk: `TASK#${id}`, entityType: "DEVELOPER_LIMIT_TASK", taskId: id, memberSk: "MEMBER", chargedAt: TIME });
  };
  const counters = (h: ReturnType<typeof world>, leaver: number, peer: number, org: number) => {
    h.db.set({ pk: LEAVER_LIMIT, sk: "MEMBER", entityType: "DEVELOPER_LIMIT", count: leaver });
    if (peer > 0) h.db.set({ pk: PEER_LIMIT, sk: "MEMBER", entityType: "DEVELOPER_LIMIT", count: peer });
    h.db.set({ pk: `ORG_LIMIT#${A}`, sk: "ORGANIZATION", entityType: "ORG_LIMIT", count: org });
  };

  it("two tasks move to the successor: the leaver's counter goes down by two and the successor's up by two (once each), each marker and each task's own counter move, the company's count stays", async () => {
    const h = world();
    slotted(h, TASK1); slotted(h, TASK2);
    counters(h, 3, 1, 9);
    expect(await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER })).toMatchObject({ status: 200, body: { moved: { tasks: 2, tasksLeft: 0 } } });
    expect(h.db.get(LEAVER_LIMIT, "MEMBER")).toMatchObject({ count: 1 });
    expect(h.db.get(PEER_LIMIT, "MEMBER")).toMatchObject({ count: 3 });
    expect(h.db.get(`ORG_LIMIT#${A}`, "ORGANIZATION")).toMatchObject({ count: 9 });
    for (const id of [TASK1, TASK2]) {
      expect(h.db.get(LEAVER_LIMIT, `TASK#${id}`)).toBeUndefined();
      expect(h.db.get(PEER_LIMIT, `TASK#${id}`)).toMatchObject({ taskId: id, memberSk: "MEMBER", chargedAt: TIME });
      expect((h.db.get(`DEVTASK#${id}`, "META") as { charge: { member: { pk: string }; organization: { pk: string } } }).charge).toEqual(charge(PEER_LIMIT));
    }
  });

  it("a task that holds no slot (no marker), or whose slot is another person's, moves none and is still handed over", async () => {
    const h = world();
    h.task(TASK1, { charge: charge(LEAVER_LIMIT) });
    h.task(TASK2, { charge: charge(`DEVELOPER_LIMIT#${OTHER}`) });
    h.db.set({ pk: `DEVELOPER_LIMIT#${OTHER}`, sk: `TASK#${TASK2}`, entityType: "DEVELOPER_LIMIT_TASK", taskId: TASK2, memberSk: "MEMBER", chargedAt: TIME });
    counters(h, 2, 0, 4); h.db.set({ pk: `DEVELOPER_LIMIT#${OTHER}`, sk: "MEMBER", entityType: "DEVELOPER_LIMIT", count: 1 });
    expect(await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER })).toMatchObject({ status: 200, body: { moved: { tasks: 2, tasksLeft: 0 } } });
    expect(h.db.get(LEAVER_LIMIT, "MEMBER")).toMatchObject({ count: 2 });
    expect(h.db.get(PEER_LIMIT, "MEMBER")).toBeUndefined();
    expect(h.db.get(`DEVELOPER_LIMIT#${OTHER}`, "MEMBER")).toMatchObject({ count: 1 });
    expect(h.db.get(`DEVELOPER_LIMIT#${OTHER}`, `TASK#${TASK2}`)).toMatchObject({ taskId: TASK2 });
  });

  it("the preview counts the slot's steps as the commit writes them: 15 slotted tasks fit in the one transaction, 16 are refused BEFORE anyone is removed", async () => {
    const fits = world();
    for (let n = 1; n <= 15; n++) slotted(fits, taskId(n));
    counters(fits, 15, 0, 15);
    expect((await fits.preview(LEAVER, PEER)).body["handOver"]).toMatchObject({ tasks: 15, tasksLeft: 0 });
    expect(await fits.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER })).toMatchObject({ status: 200, body: { moved: { tasks: 15 } } });
    expect(fits.db.get(PEER_LIMIT, "MEMBER")).toMatchObject({ count: 15 });
    const over = world();
    for (let n = 1; n <= 16; n++) slotted(over, taskId(n));
    counters(over, 16, 0, 16);
    expect(await over.preview(LEAVER, PEER)).toEqual(refusal(400, "CONFIG_INVALID", TOO_MUCH_WORK));
    expect(await over.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER })).toEqual(refusal(400, "CONFIG_INVALID", HANDOVER_TOO_BIG));
    expect(over.revoked(LEAVER)).toBe(false);
    expect(over.db.get(LEAVER_LIMIT, "MEMBER")).toMatchObject({ count: 16 });
  });
});

describe("bounds", () => {
  it("closed tasks never count: 600 closed index rows and 250 closed co-owned tasks still preview and remove (review M3)", async () => {
    const h = world(); h.task(TASK1);
    for (let i = 0; i < 600; i++) h.db.set({ pk: `DEVELOPER#${LEAVER}`, sk: `TASK#${TIME}#c${String(i).padStart(4, "0")}`, entityType: "DEVELOPER_TASK_INDEX", taskId: `c${String(i)}`, status: "CLOSED" });
    for (let i = 0; i < 250; i++) {
      const taskId = `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`;
      h.db.set({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, developerId: OWNER, companyId: A, project: "alpha", createdAt: TIME, closedAt: TIME, workflow: { revision: 1, stage: "CLOSED" } });
      h.db.set({ pk: `ORG#${A}#INVOLVED#${LEAVER}`, sk: `TASK#${TIME}#${taskId}`, entityType: "TASK_INVOLVED", companyId: A, personId: LEAVER, taskId, createdAt: TIME, addedAt: TIME });
    }
    expect((await h.preview(LEAVER, PEER)).body["handOver"]).toMatchObject({ tasks: 1, tasksLeft: 0 });
    expect((await h.remove(LEAVER, { requestId: randomUUID(), expectedRole: "member", successorId: PEER })).body["moved"]).toMatchObject({ tasks: 1 });
  });

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
