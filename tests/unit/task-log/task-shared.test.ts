// L4-LP2: whether a hosted task is shared beyond its owner (`taskSharedOf`), from the company's own session and People records. It is the seam that keeps an owner-only task at `status_only` on a tracker whose comments
// everyone on the ticket sees. Fail closed: only a plain "someone else was given this task" is true.
import { describe, expect, it } from "vitest";
import { agentSessionKey, type JsonValue, type OrgId } from "@agentx/contracts";
import { taskSharedOf } from "../../../packages/broker/src/core/task-log/index.js";
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
const people = (store: MemoryDocumentStore, taskId: string, entries: Array<{ developerId: string; role: string }>, over: Record<string, unknown> = {}) =>
  store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: entries, ...over } });
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
    const check = async (entries: Array<{ developerId: string; role: string }>) => {
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
