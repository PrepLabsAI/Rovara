// the session levels (the hosted product's `agent-sessions/access.ts` rules, on the document store and a members seam), and what each session feature asks of them: a message to the agent needs `use`,
// stop, retry and close need `edit` (a company owner or admin may stop), following and presence need `view`, and Ask needs `use` or a working role on the project (decisions 103, 104). A person with
// no level reads a missing session; a person short of the level is told what they need. On a Code install the local owner holds `edit` on every session and nobody else holds anything.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, agentSessionKey, type OrgId, type Principal } from "@rovara-code/contracts";
import {
  SessionStore, createSessionControl, createTaskSessionItems, developerIdOf, taskSessionId, type MessagePlan, type SessionControlHost,
} from "../../packages/core/src/core/sessions/index.js";
import {
  ASK_NOT_ALLOWED_TEXT, createSessionAccess, localOwnerMembers, requireAsk, requireLevelOf, sessionPersonOf, type SessionCompanyRole, type SessionMembers, type SessionProjectRole,
} from "../../packages/core/src/core/sessions/access.js";
import { createAsk, type AskAnswerer } from "../../packages/core/src/core/sessions/ask.js";
import { followSession, recordPresence } from "../../packages/core/src/core/sessions/followers.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { createNoopAuditSink, localOwnerPrincipal } from "../../packages/core/src/ports/policy-defaults.js";
import { holdingAdmission } from "../support/holding-admission.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OWNER = localOwnerPrincipal();
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const SESSION = taskSessionId(TASK);
const T0 = "2026-11-10T10:00:00.000Z";
const clock = { ms: Date.parse("2026-11-10T10:05:00.000Z") };
const REQ = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const person = (id: string, name = id): Principal => ({ companyId: ORG, personId: id, displayName: name, roles: [], provider: "oidc" });
const id = (principal: Principal): string => developerIdOf(principal);

/** A members adapter for a company with people: each person's company role and project grants, as a test sets them. */
function members(table: Record<string, { role?: SessionCompanyRole; grants?: Record<string, SessionProjectRole>; elsewhere?: Record<string, SessionProjectRole> }>): SessionMembers {
  // `__owner` sets the local owner's own row; without it they are the company's owner and a maintainer of `web`.
  const row = (developerId: string) => (developerId === id(OWNER) ? table["__owner"] ?? { role: "owner" as const, grants: { web: "maintainer" as const } } : Object.entries(table).find(([personId]) => id(person(personId)) === developerId)?.[1]);
  return {
    companyRole: (who) => row(who.developerId)?.role,
    projectGrant: (who, project) => row(who.developerId)?.grants?.[project],
    projectRoleElsewhere: async (who, project) => row(who.developerId)?.elsewhere?.[project],
  };
}

async function world(options: { task?: Record<string, unknown>; people?: unknown; shares?: Array<Record<string, unknown>> } = {}) {
  const store = new MemoryDocumentStore();
  await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, companyId: ORG, sessionId: SESSION, conversationId: "c", title: "Add retry", requestText: "Add retry", workflow: { definitionVersion: "1.1.0", stage: "PLAN", state: "RUNNING", revision: 2, path: "QUICK", artifacts: [], decisions: [] }, ...options.task } });
  if (options.people !== undefined) await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "PEOPLE", ...(options.people as Record<string, unknown>) } });
  for (const [n, share] of (options.shares ?? []).entries()) await store.put({ item: { ...agentSessionKey(ORG, SESSION, `SHARE#${String(n)}`), sharedBy: { developerId: id(OWNER), name: "Owner" }, sharedAt: T0, ...share } });
  await store.transact(createTaskSessionItems({
    orgId: ORG, sessionId: SESSION, taskId: TASK, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Add retry", owner: OWNER, origin: "app", payer: { kind: "member", developerId: id(OWNER) } as never, now: T0,
  }));
  const session = async () => (await new SessionStore(store).get(ORG, SESSION))!;
  return { store, session };
}

const levelOf = async (store: MemoryDocumentStore, table: Parameters<typeof members>[0], who: Principal) => {
  const session = (await new SessionStore(store).get(ORG, SESSION))!;
  try { return await createSessionAccess({ store, members: members(table) }).of(who, session); } catch (error) { return (error as { code: string }).code; }
};

describe("the session levels", () => {
  it("a Code install: the local owner holds edit and may ask; anyone else, and a principal of another company, reads a missing session", async () => {
    const w = await world();
    const access = createSessionAccess({ store: w.store });
    expect(await access.of(OWNER, await w.session())).toMatchObject({ level: "edit", owner: true, orgAdmin: true, mayAsk: true });
    await expect(access.of(person("dana"), await w.session())).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The identity adapter's owner role makes a principal the company's owner, but only the session's own owner owns it; a principal of another company is no member.
    await expect(access.of({ ...person("dana"), roles: ["owner"] }, await w.session())).resolves.toMatchObject({ owner: false, orgAdmin: true });
    await expect(access.of({ ...OWNER, companyId: "org_other" }, await w.session())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await localOwnerMembers().companyRole({ companyId: ORG, developerId: id(person("dana")), principal: person("dana") })).toBeUndefined();
  });

  it("a project grant: a maintainer edits; a contributor and a collaborator view and may ask; a viewer only watches and may not ask", async () => {
    const w = await world();
    const table = { mia: { role: "member" as const, grants: { web: "maintainer" as const } }, cole: { role: "member" as const, grants: { web: "contributor" as const } }, cara: { role: "member" as const, grants: { web: "collaborator" as const } }, vic: { role: "member" as const, grants: { web: "viewer" as const } } };
    expect(await levelOf(w.store, table, person("mia"))).toMatchObject({ level: "edit", owner: false, mayAsk: true });
    expect(await levelOf(w.store, table, person("cole"))).toMatchObject({ level: "view", projectRole: "contributor", mayAsk: true });
    expect(await levelOf(w.store, table, person("cara"))).toMatchObject({ level: "view", projectRole: "collaborator", mayAsk: true });
    expect(await levelOf(w.store, table, person("vic"))).toMatchObject({ level: "view", projectRole: "viewer", mayAsk: false });
    // A member with no role on the project, and a grant on another project, read a missing session.
    expect(await levelOf(w.store, { ned: { role: "member", grants: { api: "maintainer" } } }, person("ned"))).toBe("NOT_FOUND");
    // A role found elsewhere (the hosted product's project channel) is `view`.
    expect(await levelOf(w.store, { sam: { role: "member", elsewhere: { web: "contributor" } } }, person("sam"))).toMatchObject({ level: "view", mayAsk: true });
  });

  it("a company owner or admin views every task session and may stop it; an auditor reads and works on nothing, whatever it holds", async () => {
    const w = await world({ shares: [{ principal: { kind: "org" }, level: "edit" }] });
    const admin = await levelOf(w.store, { ada: { role: "admin" } }, person("ada"));
    expect(admin).toMatchObject({ level: "edit", orgAdmin: true });
    const plain = await world();
    const adminOnly = await levelOf(plain.store, { ada: { role: "admin" } }, person("ada"));
    expect(adminOnly).toMatchObject({ level: "view", orgAdmin: true, projectRole: "maintainer" });
    expect(() => requireLevelOf(adminOnly as never, "edit", "stop it", { orgAdminMay: true })).not.toThrow();
    expect(() => requireLevelOf(adminOnly as never, "edit", "retry it")).toThrow(/SESSION_LEVEL_REQUIRED: You need "can edit" on this session to retry it\. Ask Local owner/u);
    expect(await levelOf(w.store, { aud: { role: "auditor", grants: { web: "maintainer" } } }, person("aud"))).toMatchObject({ level: "view", mayAsk: false });
  });

  it("Ask at view comes only from a project role the person really holds: a company owner or admin with no grant, or with a viewer grant, may not ask; with a working grant or `use` they may", async () => {
    const w = await world();
    expect(await levelOf(w.store, { ada: { role: "admin" } }, person("ada"))).toMatchObject({ level: "view", orgAdmin: true, mayAsk: false });
    expect(await levelOf(w.store, { ada: { role: "admin", grants: { web: "viewer" } } }, person("ada"))).toMatchObject({ level: "view", orgAdmin: true, mayAsk: false });
    expect(await levelOf(w.store, { oli: { role: "owner" } }, person("oli"))).toMatchObject({ level: "view", mayAsk: false });
    expect(await levelOf(w.store, { ada: { role: "admin", grants: { web: "contributor" } } }, person("ada"))).toMatchObject({ level: "view", mayAsk: true });
    const shared = await world({ shares: [{ principal: { kind: "member", developerId: id(person("ada")) }, level: "use" }] });
    expect(await levelOf(shared.store, { ada: { role: "admin" } }, person("ada"))).toMatchObject({ level: "use", mayAsk: true });
    // And an admin still stops at view.
    const admin = await createSessionAccess({ store: w.store, members: members({ ada: { role: "admin" } }) }).of(person("ada"), await w.session());
    expect(() => requireLevelOf(admin, "edit", "stop it", { orgAdminMay: true })).not.toThrow();
    expect(() => requireAsk(admin)).toThrow(`SESSION_LEVEL_REQUIRED: ${ASK_NOT_ALLOWED_TEXT}`);
  });

  it("shares: to a person, to a project the person has a role on, to the company; a project share never reaches an admin who is not in the project", async () => {
    const w = await world({ shares: [{ principal: { kind: "member", developerId: id(person("pat")) }, level: "use" }, { principal: { kind: "project", project: "api" }, level: "view" }] });
    expect(await levelOf(w.store, { pat: { role: "member" } }, person("pat"))).toMatchObject({ level: "use", mayAsk: true });
    expect(await levelOf(w.store, { quin: { role: "member", grants: { api: "viewer" } } }, person("quin"))).toMatchObject({ level: "view", mayAsk: false });
    expect(await levelOf(w.store, { ada: { role: "admin" } }, person("ada"))).toMatchObject({ level: "view" });
    // A `view` share gives no working role on the project: it watches but may not ask.
    expect(await levelOf(w.store, { quin: { role: "member", grants: { api: "contributor" } } }, person("quin"))).toMatchObject({ level: "view", mayAsk: false });
    // A project viewer stays a watcher whatever a share says.
    const shared = await world({ shares: [{ principal: { kind: "org" }, level: "edit" }] });
    expect(await levelOf(shared.store, { vic: { role: "member", grants: { web: "viewer" } } }, person("vic"))).toMatchObject({ level: "view", mayAsk: false });
  });

  it("the task's People list: a commenter uses, a viewer views, a denial takes everything but an admin's view (and Ask), and a list that does not read denies everyone", async () => {
    const people = { schemaVersion: 1, people: [{ developerId: id(person("cam")), role: "commenter" }, { developerId: id(person("val")), role: "viewer" }, { developerId: id(person("dee")), role: "denied" }, { developerId: id(person("ada")), role: "denied" }] };
    const w = await world({ people });
    expect(await levelOf(w.store, { cam: { role: "member" } }, person("cam"))).toMatchObject({ level: "use", mayAsk: true });
    expect(await levelOf(w.store, { val: { role: "member" } }, person("val"))).toMatchObject({ level: "view", mayAsk: false });
    expect(await levelOf(w.store, { dee: { role: "member", grants: { web: "maintainer" } } }, person("dee"))).toBe("NOT_FOUND");
    expect(await levelOf(w.store, { ada: { role: "admin" } }, person("ada"))).toMatchObject({ level: "view", mayAsk: false });
    const broken = await world({ people: { schemaVersion: 1, people: [{ developerId: "x", role: "boss" }] } });
    expect(await levelOf(broken.store, { mia: { role: "member", grants: { web: "maintainer" } } }, person("mia"))).toBe("NOT_FOUND");
  });

  it("a take-over: the taker owns the session, the creator no longer does, and a taker that does not read gives nobody an owner's access", async () => {
    const taker = person("tia", "Tia");
    const w = await world({ task: { currentOwner: { developerId: id(taker), name: "Tia", provider: "oidc", since: T0 } } });
    expect(await levelOf(w.store, { tia: { role: "member" } }, taker)).toMatchObject({ level: "edit", owner: true, effectiveOwner: { developerId: id(taker), name: "Tia" } });
    // The creator, now only a member with no role on the project, holds nothing.
    expect(await levelOf(w.store, { tia: { role: "member" }, __owner: { role: "member" } }, OWNER)).toBe("NOT_FOUND");
    const unreadable = await world({ task: { currentOwner: { developerId: id(taker), provider: "carrier-pigeon", since: T0 } } });
    expect(await levelOf(unreadable.store, { tia: { role: "member" } }, taker)).toBe("TASK_ACCESS_DENIED");
  });

  it("Ask's own check names the viewer rule and the missing role in fixed words", async () => {
    const w = await world();
    const vic = await createSessionAccess({ store: w.store, members: members({ vic: { role: "member", grants: { web: "viewer" } } }) }).of(person("vic"), await w.session());
    expect(() => requireAsk(vic)).toThrow("SESSION_LEVEL_REQUIRED: Viewers of web can only watch its sessions.");
    const shared = await world({ shares: [{ principal: { kind: "member", developerId: id(person("sol")) }, level: "view" }] });
    const sol = await createSessionAccess({ store: shared.store, members: members({ sol: { role: "member" } }) }).of(person("sol"), await shared.session());
    expect(() => requireAsk(sol)).toThrow(`SESSION_LEVEL_REQUIRED: ${ASK_NOT_ALLOWED_TEXT}`);
    expect(sessionPersonOf(OWNER).developerId).toBe(id(OWNER));
  });
});

describe("what each feature asks of the levels", () => {
  const table = { cole: { role: "member" as const, grants: { web: "contributor" as const } }, ada: { role: "admin" as const }, vic: { role: "member" as const, grants: { web: "viewer" as const } } };
  const commenter = { schemaVersion: 1, people: [{ developerId: id(person("cam")), role: "commenter" }] };

  async function controlled(options: { people?: unknown } = {}) {
    const w = await world(options);
    const plans: Array<{ owner: boolean; developerId: string }> = [];
    const calls: string[] = [];
    const host: SessionControlHost = {
      cancelTask: async () => { calls.push("cancel"); }, retryWorkflow: async () => { calls.push("retry"); }, closeTask: async () => { calls.push("close"); },
      async planMessage(_taskId, message): Promise<MessagePlan> { plans.push({ owner: message.owner, developerId: message.author.developerId }); return { state: "queued" }; },
    };
    const control = createSessionControl({ store: w.store, audit: createNoopAuditSink(), host, members: members({ ...table, cam: { role: "member" } }), now: () => new Date(clock.ms), log: () => undefined });
    return { ...w, control, plans, calls };
  }

  it("a message to the agent needs use: a commenter's goes as information (never the owner's instruction); a contributor is told what they need; a stranger reads a missing session", async () => {
    const w = await controlled({ people: commenter });
    expect(await w.control.tell(person("cam"), ORG, SESSION, { requestId: REQ(1), text: "check the retry count" })).toMatchObject({ status: "done" });
    expect(w.plans).toEqual([{ owner: false, developerId: id(person("cam")) }]);
    expect(await w.control.tell(person("cole"), ORG, SESSION, { requestId: REQ(2), text: "x" })).toEqual({ status: "refused", reason: "forbidden", message: 'You need "can use" on this session to send messages to the agent. Ask Local owner to share it with you.' });
    expect(await w.control.tell(person("vic"), ORG, SESSION, { requestId: REQ(3), text: "x" })).toEqual({ status: "refused", reason: "forbidden", message: "Viewers of web can only watch its sessions." });
    expect(await w.control.tell(person("zed"), ORG, SESSION, { requestId: REQ(4), text: "x" })).toMatchObject({ status: "refused", reason: "not_found" });
    expect(await w.control.tell(OWNER, ORG, SESSION, { requestId: REQ(5), text: "use the other table" })).toMatchObject({ status: "done" });
    expect(w.plans[1]).toEqual({ owner: true, developerId: id(OWNER) });
    expect(w.plans).toHaveLength(2);
  });

  it("a task whose taker does not read refuses every action with its own reason, never as a level", async () => {
    const w = await world({ task: { currentOwner: { developerId: "x", provider: "carrier-pigeon", since: T0 } } });
    const control = createSessionControl({ store: w.store, audit: createNoopAuditSink(), host: { cancelTask: async () => undefined, retryWorkflow: async () => undefined }, now: () => new Date(clock.ms), log: () => undefined });
    expect(await control.stop(OWNER, ORG, SESSION, { requestId: REQ(30) })).toEqual({ status: "refused", reason: "task_access_denied", message: "Rovara can't tell who owns this task right now, so it did nothing." });
  });

  it("stop needs edit, and a company admin may stop; retry and close need edit; nothing reaches the task for a person short of the level", async () => {
    const w = await controlled({ people: commenter });
    expect(await w.control.stop(person("cam"), ORG, SESSION, { requestId: REQ(10) })).toMatchObject({ status: "refused", reason: "forbidden" });
    expect(await w.control.stop(person("cole"), ORG, SESSION, { requestId: REQ(11) })).toMatchObject({ status: "refused", reason: "forbidden" });
    expect(w.calls).toEqual([]);
    expect(await w.control.stop(person("ada"), ORG, SESSION, { requestId: REQ(12) })).toMatchObject({ status: "done" });
    expect(w.calls).toEqual(["cancel"]);
    expect(await w.control.close(person("ada"), ORG, SESSION, { requestId: REQ(13) })).toMatchObject({ status: "refused", reason: "forbidden", message: expect.stringContaining("to close it") });
    expect(await w.control.close(person("zed"), ORG, SESSION, { requestId: REQ(14) })).toMatchObject({ status: "refused", reason: "not_found" });
    expect(w.calls).toEqual(["cancel"]);
  });

  it("following and presence need view: a contributor follows with an item, a stranger reads a missing session, and the taker of a task follows without one", async () => {
    const w = await world();
    const deps = { store: w.store, members: members(table), now: () => new Date(clock.ms) };
    expect(await followSession(deps, person("cole"), ORG, SESSION)).toEqual({ following: true });
    expect(await w.store.get(agentSessionKey(ORG, SESSION, `FOLLOWER#${id(person("cole"))}`))).toBeDefined();
    expect((await w.session()).followerCount).toBe(1);
    await expect(followSession(deps, person("zed"), ORG, SESSION)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(recordPresence(deps, person("zed"), ORG, SESSION)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await recordPresence(deps, person("vic"), ORG, SESSION)).viewingNow.map((who) => who.name)).toEqual(["vic"]);
    const taker = person("tia", "Tia");
    const taken = await world({ task: { currentOwner: { developerId: id(taker), name: "Tia", provider: "oidc", since: T0 } } });
    expect(await followSession({ store: taken.store, members: members({ tia: { role: "member" } }) }, taker, ORG, SESSION)).toEqual({ following: true });
    expect((await taken.session()).followerCount).toBe(0);
  });

  describe("Ask", () => {
    const answerer = (calls: string[]): AskAnswerer => ({ async answer(input) { calls.push(input.question); return { text: "It is planning.", model: "anthropic/test-model", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, provider: "anthropic", modelId: "test-model" } }; } });
    async function asking(table2: Parameters<typeof members>[0], options: { people?: unknown } = {}) {
      const w = await world(options);
      const calls: string[] = [];
      const held = holdingAdmission();
      const ask = createAsk({ store: w.store, audit: createNoopAuditSink(), answerer: answerer(calls), admission: held.admission, members: members(table2), questionHashKey: "k".repeat(32), now: () => new Date(clock.ms) });
      return { ...w, ask, calls, held };
    }

    it("a contributor and a collaborator may ask a task they can view (decisions 103, 104), through admission, as themselves", async () => {
      for (const role of ["contributor", "collaborator"] as const) {
        const w = await asking({ cole: { role: "member", grants: { web: role } } });
        const submitted = await w.ask.submit(person("cole"), ORG, SESSION, { requestId: REQ(20), question: "Where is it?" });
        await w.ask.idle();
        expect(await w.ask.status(person("cole"), ORG, SESSION, submitted.askId)).toMatchObject({ state: "answered", answer: "It is planning." });
        expect(w.held.asked).toHaveLength(1);
        expect(w.held.asked[0]).toMatchObject({ action: "model.call", actor: { personId: "cole" }, subject: { type: "task", id: TASK } });
        expect(w.held.open()).toEqual([]);
        expect(w.calls).toEqual(["Where is it?"]);
      }
    });

    it("a project viewer, an auditor, a person a People entry denies and a stranger may not: nothing is admitted, rated or asked", async () => {
      const denied = { schemaVersion: 1, people: [{ developerId: id(person("ada")), role: "denied" }] };
      const w = await asking({ vic: { role: "member", grants: { web: "viewer" } }, aud: { role: "auditor", grants: { web: "contributor" } }, ada: { role: "admin" } }, { people: denied });
      await expect(w.ask.submit(person("vic"), ORG, SESSION, { requestId: REQ(21), question: "q" })).rejects.toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
      await expect(w.ask.submit(person("aud"), ORG, SESSION, { requestId: REQ(22), question: "q" })).rejects.toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
      await expect(w.ask.submit(person("ada"), ORG, SESSION, { requestId: REQ(23), question: "q" })).rejects.toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
      await expect(w.ask.submit(person("zed"), ORG, SESSION, { requestId: REQ(24), question: "q" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(w.held.asked).toEqual([]);
      expect(w.calls).toEqual([]);
      expect((await w.store.query({ pk: agentSessionKey(ORG, SESSION, "META").pk, sk: { op: "beginsWith", prefix: "ASKREQ#" } })).items).toEqual([]);
    });

    it("an asker whose access ended before the answer turn gets nothing: the model is not asked and the allowance goes back", async () => {
      const w = await world();
      const calls: string[] = [];
      const held = holdingAdmission();
      // Cole is a contributor when they ask, and removed from the company before the answer turn reads their access again.
      let reads = 0;
      const leaving: SessionMembers = { companyRole: (who) => (who.developerId === id(person("cole")) && (reads += 1) === 1 ? "member" : undefined), projectGrant: () => "contributor" };
      const ask = createAsk({ store: w.store, audit: createNoopAuditSink(), answerer: answerer(calls), admission: held.admission, members: leaving, questionHashKey: "k".repeat(32), now: () => new Date(clock.ms) });
      const submitted = await ask.submit(person("cole"), ORG, SESSION, { requestId: REQ(25), question: "q" });
      await ask.idle();
      expect(reads).toBe(2);
      const v = { ...w, ask, calls, held };
      expect(v.calls).toEqual([]);
      expect(v.held.released).toEqual(["held-1"]);
      expect(v.held.open()).toEqual([]);
      await expect(v.ask.status(person("cole"), ORG, SESSION, submitted.askId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("reading an Ask needs view, and only its asker reads it", async () => {
      const w = await asking({ cole: { role: "member", grants: { web: "contributor" } }, vic: { role: "member", grants: { web: "viewer" } } });
      const submitted = await w.ask.submit(person("cole"), ORG, SESSION, { requestId: REQ(26), question: "q" });
      await w.ask.idle();
      await expect(w.ask.status(person("vic"), ORG, SESSION, submitted.askId)).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("no such session") });
      await expect(w.ask.status(person("zed"), ORG, SESSION, submitted.askId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
