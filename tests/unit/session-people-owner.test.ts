// TASK-TAKEOVER PR A: who owns a task's SESSION follows the task's People list once the list no longer calls the session's starter an owner (a hand-over, a take-over, a starter the list denied).
// A People entry is keyed by the person's sign-in id (the task's own `developerId`, a principal's `personId`); a session names people by a hash of it (SESSION-PEOPLE-KEY: the list is read by the sign-in id only).
//   - with no list, or a list that still names the starter an owner, nothing changes: the starter owns the session (with the project grant) and a co-owner does not;
//   - once the list has moved on, the starter owns nothing even with the project grant back, and a person the list names an owner owns the session as themselves, under the same live grant test.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type JsonValue, type OrgId, type Principal } from "@agentx/contracts";
import { SessionStore, createTaskSessionItems, developerIdOf, taskSessionId } from "../../packages/broker/src/core/sessions/index.js";
import { createSessionAccess, type SessionMembers, type SessionProjectRole } from "../../packages/broker/src/core/sessions/access.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const SESSION = taskSessionId(TASK);
const T0 = "2026-11-10T10:00:00.000Z";
const person = (personId: string, name: string): Principal => ({ companyId: ORG, personId, displayName: name, roles: [], provider: "oidc" });
const STARTER = person("starter-sign-in-id", "Sam Starter");
const SUCCESSOR = person("successor-sign-in-id", "Sue Successor");
const COLLEAGUE = person("colleague-sign-in-id", "Cy Colleague");
const entry = (who: Principal, role: string) => ({ developerId: who.personId, name: who.displayName, role, method: "oidc" });

/** Everyone is a company member; the grants are as the test says. */
const members = (grants: Record<string, SessionProjectRole | undefined>): SessionMembers => ({
  companyRole: (who) => (who.principal === undefined ? undefined : "member"),
  projectGrant: (who) => (who.principal === undefined ? undefined : grants[who.principal.personId]),
});

async function world(people: unknown[] | undefined, extra: { orphaned?: boolean } = {}) {
  const store = new MemoryDocumentStore();
  await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, companyId: ORG, developerId: STARTER.personId, sessionId: SESSION, conversationId: "c", title: "Add retry", requestText: "Add retry",
    workflow: { definitionVersion: "1.1.0", stage: "PLAN", state: "RUNNING", revision: 2, path: "QUICK", artifacts: [], decisions: [] } } });
  if (people !== undefined) await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: extra.orphaned === true, people: people as JsonValue } });
  await store.transact(createTaskSessionItems({ orgId: ORG, sessionId: SESSION, taskId: TASK, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Add retry", owner: STARTER, origin: "app", payer: { kind: "member", developerId: developerIdOf(STARTER) } as never, now: T0 }));
  return { store, session: async () => (await new SessionStore(store).get(ORG, SESSION))! };
}

const GRANTS = { [STARTER.personId]: "contributor", [SUCCESSOR.personId]: "contributor", [COLLEAGUE.personId]: "contributor" } as const;
const read = async (w: Awaited<ReturnType<typeof world>>, who: Principal, grants: Record<string, SessionProjectRole | undefined> = GRANTS) => {
  try { return await createSessionAccess({ store: w.store, members: members(grants) }).of(who, await w.session()); } catch (error) { return (error as { code: string }).code; }
};

describe("who owns a task's session when its People list has moved on", () => {
  it("with no list, or a list that still names the starter an owner: the starter owns it, a co-owner does not (nothing changes)", async () => {
    const none = await world(undefined);
    expect(await read(none, STARTER)).toMatchObject({ owner: true, level: "edit" });
    expect(await read(none, SUCCESSOR)).toMatchObject({ owner: false });
    const both = await world([entry(STARTER, "owner"), entry(SUCCESSOR, "owner")]);
    expect(await read(both, STARTER)).toMatchObject({ owner: true });
    expect(await read(both, SUCCESSOR)).toMatchObject({ owner: false });
  });

  it("handed over: the starter, with the project granted back, owns nothing and reads nothing (the list denied them: a denial applies, as in the task path); the successor owns it as themselves", async () => {
    const w = await world([entry(STARTER, "denied"), entry(SUCCESSOR, "owner")]);
    expect(await read(w, STARTER)).toBe("NOT_FOUND");
    const successor = await read(w, SUCCESSOR);
    expect(successor).toMatchObject({ owner: true, level: "edit", effectiveOwner: { developerId: developerIdOf(SUCCESSOR), name: "Sue Successor" } });
    // A colleague the list does not name owns nothing, and an owner without the project grant owns nothing either (the same live test every owner meets).
    expect(await read(w, COLLEAGUE)).not.toMatchObject({ owner: true });
    expect(await read(w, SUCCESSOR, { ...GRANTS, [SUCCESSOR.personId]: undefined })).not.toMatchObject({ owner: true });
  });

  it("a starter the list demoted to a commenter is not the owner either, even with the grant", async () => {
    const w = await world([entry(STARTER, "commenter"), entry(SUCCESSOR, "owner")]);
    expect(await read(w, STARTER)).not.toMatchObject({ owner: true });
    expect(await read(w, SUCCESSOR)).toMatchObject({ owner: true });
  });

  it("a list with no owner at all (orphaned): nobody owns the session, the starter included", async () => {
    const w = await world([entry(STARTER, "denied"), entry(COLLEAGUE, "commenter")], { orphaned: true });
    expect(await read(w, STARTER)).toBe("NOT_FOUND");
    expect(await read(w, COLLEAGUE)).not.toMatchObject({ owner: true });
  });

  it("says when the list moved the person BELOW owner (a commenter, a viewer or a denial), so a starter the list moved on stops seeing the task's money; a list that names others only, or no list, says nothing", async () => {
    const demoted = await world([entry(STARTER, "commenter"), entry(SUCCESSOR, "owner")]);
    expect(await read(demoted, STARTER)).toMatchObject({ listedBelowOwner: true });
    expect(await read(demoted, SUCCESSOR)).not.toHaveProperty("listedBelowOwner");
    const others = await world([entry(SUCCESSOR, "owner")]);
    expect(await read(others, STARTER)).not.toHaveProperty("listedBelowOwner");
    expect(await read(await world(undefined), STARTER)).not.toHaveProperty("listedBelowOwner");
  });
});
