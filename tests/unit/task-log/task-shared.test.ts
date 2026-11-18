// L4-LP2: whether a hosted task is shared beyond its owner (`taskSharedOf`), from the company's own session and People records. It is the seam that keeps an owner-only task at `status_only` on a tracker whose comments
// everyone on the ticket sees. Fail closed: only a plain "someone else was given this task" is true.
import { describe, expect, it } from "vitest";
import { agentSessionKey, type JsonValue, type OrgId } from "@agentx/contracts";
import { taskSharedOf } from "../../../packages/broker/src/core/task-log/index.js";
import { deployedSessionMembers } from "../../../packages/broker/src/core-host/deployed-decisions.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../../packages/broker/src/core-host/hosted-modules.js";
import type { SessionMembers } from "../../../packages/broker/src/core/sessions/access.js";
import { taskSessionId } from "../../../packages/broker/src/core/sessions/create.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const OTHER_TASK = "9c68ac5c-fbb8-4c03-98cd-7eb97ca8d0f7";
const DEV = (n: string): string => n.repeat(64);

async function put(store: MemoryDocumentStore, taskId: string, company: OrgId, over: Record<string, JsonValue> = {}): Promise<void> {
  await store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, companyId: company, project: "web", sessionId: taskSessionId(taskId), title: "t", ...over } });
}
type Entry = { developerId: string; role: string; method?: string };
/** A bare { developerId, role } is a Slack entry (the pre-C1 shape: a chat account id, no method); one with a `method` is a web entry (no chat account id). */
const entryOf = (entry: Entry): Record<string, unknown> => (entry.method === undefined ? { ...entry, slackUserId: "UAAAAAAAA", name: "Ana" } : { ...entry, name: "Ana" });
const people = (store: MemoryDocumentStore, taskId: string, entries: Entry[], over: Record<string, unknown> = {}) =>
  store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: entries.map(entryOf), ...over } });
const share = (store: MemoryDocumentStore, company: OrgId, taskId: string, n: number, principal: JsonValue) =>
  store.put({ item: { ...agentSessionKey(company, taskSessionId(taskId), `SHARE#${String(n)}`), principal, level: "view", sharedBy: { developerId: DEV("a"), name: "Owner" }, sharedAt: "2026-11-17T10:00:00.000Z" } });

describe("a task is shared beyond its owner only when the company's records say someone else has it", () => {
  it("an owner-only task is not shared: no People list, no share, no takeover", async () => {
    const store = new MemoryDocumentStore();
    await put(store, TASK, A);
    expect(await taskSharedOf({ store })(A, TASK)).toBe(false);
  });

  it("a session share to a person, a project or the whole company makes it shared", async () => {
    for (const principal of [{ kind: "member", developerId: DEV("b") }, { kind: "project", project: "web" }, { kind: "org" }]) {
      const store = new MemoryDocumentStore();
      await put(store, TASK, A);
      await share(store, A, TASK, 1, principal);
      expect(await taskSharedOf({ store })(A, TASK), JSON.stringify(principal)).toBe(true);
    }
  });

  it("a People commenter or viewer, or a second owner, makes it shared; the owner alone, or a denial alone, does not", async () => {
    const check = async (entries: Entry[]) => {
      const store = new MemoryDocumentStore();
      await put(store, TASK, A);
      await people(store, TASK, entries);
      return taskSharedOf({ store })(A, TASK);
    };
    expect(await check([{ developerId: DEV("a"), role: "owner" }, { developerId: DEV("b"), role: "commenter" }])).toBe(true);
    expect(await check([{ developerId: DEV("a"), role: "owner" }, { developerId: DEV("b"), role: "viewer" }])).toBe(true);
    expect(await check([{ developerId: DEV("a"), role: "owner" }, { developerId: DEV("b"), role: "owner" }])).toBe(true);
    expect(await check([{ developerId: DEV("a"), role: "owner" }])).toBe(false);
    expect(await check([{ developerId: DEV("a"), role: "owner" }, { developerId: DEV("b"), role: "denied" }])).toBe(false);
  });

  it("a taken-over task and a shared Slack thread task are shared", async () => {
    const taken = new MemoryDocumentStore();
    await put(taken, TASK, A, { currentOwner: { developerId: DEV("b"), provider: "slack", since: "2026-11-17T10:00:00.000Z" } });
    expect(await taskSharedOf({ store: taken })(A, TASK)).toBe(true);
    const thread = new MemoryDocumentStore();
    await put(thread, TASK, A, { share: { teamId: "T1", channelId: "C1", threadTs: "1.2" } });
    expect(await taskSharedOf({ store: thread })(A, TASK)).toBe(true);
  });

  it("an unreadable People list, a missing task and a malformed session id are not shared", async () => {
    const bad = new MemoryDocumentStore();
    await put(bad, TASK, A);
    await people(bad, TASK, [{ developerId: DEV("b"), role: "commenter" }], { schemaVersion: 2 });
    expect(await taskSharedOf({ store: bad })(A, TASK)).toBe(false);
    // Even with a session share beside it: an unreadable list is not shared.
    await share(bad, A, TASK, 1, { kind: "org" });
    expect(await taskSharedOf({ store: bad })(A, TASK)).toBe(false);
    // A malformed takeover field is no second person.
    const malformed = new MemoryDocumentStore();
    await put(malformed, TASK, A, { currentOwner: null });
    expect(await taskSharedOf({ store: malformed })(A, TASK)).toBe(false);
    expect(await taskSharedOf({ store: new MemoryDocumentStore() })(A, TASK)).toBe(false);
    const noSession = new MemoryDocumentStore();
    await put(noSession, TASK, A, { sessionId: "../x" });
    expect(await taskSharedOf({ store: noSession })(A, TASK)).toBe(false);
  });
});

describe("two companies, two tasks: another company's records never make this one shared", () => {
  it("company B's view of company A's task is false even when A's task is shared", async () => {
    const store = new MemoryDocumentStore();
    await put(store, TASK, A);
    await share(store, A, TASK, 1, { kind: "org" });
    expect(await taskSharedOf({ store })(A, TASK)).toBe(true);
    expect(await taskSharedOf({ store })(B, TASK)).toBe(false);
  });

  it("a share row under another company's partition (same session id) does not count for this company", async () => {
    const store = new MemoryDocumentStore();
    await put(store, TASK, A);
    await share(store, B, TASK, 1, { kind: "org" });
    expect(await taskSharedOf({ store })(A, TASK)).toBe(false);
  });

  it("a shared task next to an owner-only task: each answer is its own", async () => {
    const store = new MemoryDocumentStore();
    await put(store, TASK, A);
    await put(store, OTHER_TASK, A);
    await share(store, A, TASK, 1, { kind: "org" });
    const shared = taskSharedOf({ store });
    expect([await shared(A, TASK), await shared(A, OTHER_TASK)]).toEqual([true, false]);
  });

  it("a task record that names company B is not company A's even with A's id on the question", async () => {
    const store = new MemoryDocumentStore();
    await put(store, TASK, B);
    await people(store, TASK, [{ developerId: DEV("b"), role: "commenter" }]);
    expect(await taskSharedOf({ store })(A, TASK)).toBe(false);
    expect(await taskSharedOf({ store })(B, TASK)).toBe(true);
  });
});

// ---- L4-LP4: a web People entry counts only while that person's project grant is live now (the review's Low on L4-LP2)

const WEB = (n: string, role: string): Entry => ({ developerId: DEV(n), role, method: "cloud" });
type Grant = "developer" | "administrator" | undefined;
/** The broker's own records as the hosted members reader sees them: who is a live member of which company, and each person's grant per project. */
function directory(opts: { members?: Record<string, OrgId>; grants?: Record<string, Grant>; fail?: "member" | "grant" } = {}) {
  const calls: Array<{ kind: "member" | "grant"; personId: string; project?: string }> = [];
  const people = {
    membershipOf: async (personId: string) => {
      calls.push({ kind: "member", personId });
      if (opts.fail === "member") throw new Error("dynamo down");
      const company = opts.members?.[personId];
      return company === undefined ? undefined : { companyId: company, role: "member" as const };
    },
    projectGrantRole: async (personId: string, project: string) => {
      calls.push({ kind: "grant", personId, project });
      if (opts.fail === "grant") throw new Error("dynamo down");
      return opts.grants?.[`${personId}/${project}`];
    },
  };
  return { people, calls };
}
const sharedWith = (store: MemoryDocumentStore, companyOfMembers: OrgId, dir: ReturnType<typeof directory>, members?: SessionMembers) =>
  taskSharedOf({ store, webPeople: { members: members ?? deployedSessionMembers(companyOfMembers, dir.people), provider: HOSTED_IDENTITY_PROVIDER } });
async function withPeople(entries: Entry[], extra: Record<string, JsonValue> = {}) {
  const store = new MemoryDocumentStore();
  await put(store, TASK, A, extra);
  await people(store, TASK, entries);
  return store;
}

describe("L4-LP4: a web People entry counts as shared only while the person's grant on the task's project is live", () => {
  const live = () => directory({ members: { [DEV("b")]: A }, grants: { [`${DEV("b")}/web`]: "developer" } });

  it("a web commenter, viewer or second owner with a live grant on the task's project makes it shared", async () => {
    for (const second of [WEB("b", "commenter"), WEB("b", "viewer"), WEB("b", "owner")]) {
      const store = await withPeople([WEB("a", "owner"), second]);
      // The task's own owner is live too for the second-owner case: two live owners.
      const dir = directory({ members: { [DEV("a")]: A, [DEV("b")]: A }, grants: { [`${DEV("a")}/web`]: "administrator", [`${DEV("b")}/web`]: "developer" } });
      expect(await sharedWith(store, A, dir)(A, TASK), second.role).toBe(true);
    }
  });

  it("a web commenter who lost the project grant no longer makes the task shared (a project administrator's grant counts too)", async () => {
    const store = await withPeople([WEB("a", "owner"), WEB("b", "commenter")]);
    expect(await sharedWith(store, A, live())(A, TASK)).toBe(true);
    const revoked = directory({ members: { [DEV("b")]: A }, grants: {} });
    expect(await sharedWith(store, A, revoked)(A, TASK)).toBe(false);
    const admin = directory({ members: { [DEV("b")]: A }, grants: { [`${DEV("b")}/web`]: "administrator" } });
    expect(await sharedWith(store, A, admin)(A, TASK)).toBe(true);
  });

  it("a web viewer who lost the grant, and a second web owner who lost it, no longer make it shared", async () => {
    for (const second of [WEB("b", "viewer"), WEB("b", "owner")]) {
      const store = await withPeople([WEB("a", "owner"), second]);
      const dir = directory({ members: { [DEV("a")]: A }, grants: { [`${DEV("a")}/web`]: "developer" } });
      expect(await sharedWith(store, A, dir)(A, TASK), second.role).toBe(false);
    }
  });

  it("a person who is no longer a member of the company is not live, even with a grant row left behind", async () => {
    const store = await withPeople([WEB("a", "owner"), WEB("b", "commenter")]);
    const gone = directory({ members: {}, grants: { [`${DEV("b")}/web`]: "developer" } });
    expect(await sharedWith(store, A, gone)(A, TASK)).toBe(false);
  });

  it("the grant must be on THIS task's project: a grant on another project does not count", async () => {
    const store = await withPeople([WEB("a", "owner"), WEB("b", "commenter")]);
    const elsewhere = directory({ members: { [DEV("b")]: A }, grants: { [`${DEV("b")}/billing`]: "developer" } });
    expect(await sharedWith(store, A, elsewhere)(A, TASK)).toBe(false);
    const dir = live();
    await sharedWith(store, A, dir)(A, TASK);
    expect(dir.calls.filter((c) => c.kind === "grant").map((c) => c.project)).toEqual(["web"]);
  });

  it("a task whose project is missing, empty or not a name cannot have a grant checked: its web entries do not count", async () => {
    const anyGrant: SessionMembers = { companyRole: async () => "member", projectGrant: async () => "contributor" };
    for (const project of ["", 5, null] as const) {
      const store = await withPeople([WEB("a", "owner"), WEB("b", "commenter")], { project });
      expect(await sharedWith(store, A, live(), anyGrant)(A, TASK), JSON.stringify(project)).toBe(false);
    }
    // Positive control: the same reader counts the entry when the task names its project.
    expect(await sharedWith(await withPeople([WEB("a", "owner"), WEB("b", "commenter")]), A, live(), anyGrant)(A, TASK)).toBe(true);
  });

  it("a read that fails is not shared (fail closed): a failed membership read and a failed grant read each leave the task unshared", async () => {
    const store = await withPeople([WEB("a", "owner"), WEB("b", "commenter")]);
    for (const fail of ["member", "grant"] as const) {
      expect(await sharedWith(store, A, directory({ fail, members: { [DEV("b")]: A }, grants: { [`${DEV("b")}/web`]: "developer" } }))(A, TASK), fail).toBe(false);
    }
    // A members reader that throws outright (not the deployed one, which swallows its own faults) is no grant either.
    const throwing: SessionMembers = { companyRole: async () => { throw new Error("boom"); }, projectGrant: async () => { throw new Error("boom"); } };
    expect(await sharedWith(store, A, live(), throwing)(A, TASK)).toBe(false);
    const grantThrows: SessionMembers = { companyRole: async () => "member", projectGrant: async () => { throw new Error("boom"); } };
    expect(await sharedWith(store, A, live(), grantThrows)(A, TASK)).toBe(false);
    const roleThrows: SessionMembers = { companyRole: async () => { throw new Error("boom"); }, projectGrant: async () => "contributor" };
    expect(await sharedWith(store, A, live(), roleThrows)(A, TASK)).toBe(false);
  });

  it("a members reader that finds no company role is not live even if it names a grant", async () => {
    const store = await withPeople([WEB("a", "owner"), WEB("b", "commenter")]);
    const noRole: SessionMembers = { companyRole: async () => undefined, projectGrant: async () => "contributor" };
    expect(await sharedWith(store, A, live(), noRole)(A, TASK)).toBe(false);
  });

  it("with no members reader given, a web entry cannot be checked and is ignored (fail closed); a Slack entry is unchanged", async () => {
    const web = await withPeople([WEB("a", "owner"), WEB("b", "commenter")]);
    expect(await taskSharedOf({ store: web })(A, TASK)).toBe(false);
    const slack = await withPeople([{ developerId: DEV("a"), role: "owner" }, { developerId: DEV("b"), role: "commenter" }]);
    expect(await taskSharedOf({ store: slack })(A, TASK)).toBe(true);
    expect(await sharedWith(slack, A, directory())(A, TASK)).toBe(true);
  });

  it("an entry that is neither a Slack nor a web shape cannot be checked either: it is treated like a web entry, so it does not count without a live grant", async () => {
    const store = new MemoryDocumentStore();
    await put(store, TASK, A);
    await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: DEV("b"), role: "commenter" }] } });
    expect(await taskSharedOf({ store })(A, TASK)).toBe(false);
    expect(await sharedWith(store, A, directory({ members: { [DEV("b")]: A }, grants: {} }))(A, TASK)).toBe(false);
    expect(await sharedWith(store, A, live())(A, TASK)).toBe(true);
  });

  it("a revoked web entry is only that entry: a session share, a takeover or a live Slack commenter still make it shared", async () => {
    const revoked = directory({ members: {}, grants: {} });
    const withShare = await withPeople([WEB("a", "owner"), WEB("b", "commenter")]);
    await share(withShare, A, TASK, 1, { kind: "org" });
    expect(await sharedWith(withShare, A, revoked)(A, TASK)).toBe(true);
    const taken = await withPeople([WEB("a", "owner"), WEB("b", "commenter")], { currentOwner: { developerId: DEV("c"), provider: "slack", since: "2026-11-17T10:00:00.000Z" } });
    expect(await sharedWith(taken, A, revoked)(A, TASK)).toBe(true);
    const mixed = await withPeople([WEB("a", "owner"), WEB("b", "commenter"), { developerId: DEV("c"), role: "viewer" }]);
    expect(await sharedWith(mixed, A, revoked)(A, TASK)).toBe(true);
  });

  it("a revoked web entry does not hide a live one beside it, and a denied entry still does not count", async () => {
    const store = await withPeople([WEB("a", "owner"), WEB("b", "commenter"), WEB("c", "viewer")]);
    const dir = directory({ members: { [DEV("c")]: A }, grants: { [`${DEV("c")}/web`]: "developer" } });
    expect(await sharedWith(store, A, dir)(A, TASK)).toBe(true);
    const denied = await withPeople([WEB("a", "owner"), WEB("b", "denied")]);
    expect(await sharedWith(denied, A, live())(A, TASK)).toBe(false);
  });

  it("an unreadable People list is still not shared, whatever the live check would say", async () => {
    const store = await withPeople([WEB("a", "owner"), WEB("b", "commenter")]);
    await people(store, TASK, [WEB("b", "commenter")], { schemaVersion: 2 });
    expect(await sharedWith(store, A, live())(A, TASK)).toBe(false);
  });
});

describe("L4-LP4: two companies, the live check is the company's own", () => {
  it("a web commenter who is a live member of company B only (with a grant on a project of the same name) does not make company A's task shared", async () => {
    const store = await withPeople([WEB("a", "owner"), WEB("b", "commenter")]);
    const dir = directory({ members: { [DEV("b")]: B }, grants: { [`${DEV("b")}/web`]: "developer" } });
    expect(await sharedWith(store, A, dir)(A, TASK)).toBe(false);
  });

  it("company B's members reader cannot make company A's task shared, and company A's reader cannot make company B's task shared", async () => {
    const store = new MemoryDocumentStore();
    await put(store, TASK, A);
    await people(store, TASK, [WEB("a", "owner"), WEB("b", "commenter")]);
    await put(store, OTHER_TASK, B);
    await people(store, OTHER_TASK, [WEB("a", "owner"), WEB("b", "commenter")]);
    const dir = directory({ members: { [DEV("b")]: A }, grants: { [`${DEV("b")}/web`]: "developer" } });
    const forA = sharedWith(store, A, dir);
    const forB = sharedWith(store, B, dir);
    expect(await forA(A, TASK)).toBe(true);
    expect(await forB(A, TASK)).toBe(false);
    // B's task asked through A's reader: B's own task, but the person is not a member of B.
    expect(await forA(B, OTHER_TASK)).toBe(false);
    expect(await forB(B, OTHER_TASK)).toBe(false);
  });

  it("the person asked about is the company's: a live member of A with a grant is not looked up as another company's person", async () => {
    const store = await withPeople([WEB("a", "owner"), WEB("b", "commenter")]);
    const dir = directory({ members: { [DEV("b")]: A }, grants: { [`${DEV("b")}/web`]: "developer" } });
    await sharedWith(store, A, dir)(A, TASK);
    expect(dir.calls.every((c) => c.personId === DEV("b") || c.personId === DEV("a"))).toBe(true);
  });
});
