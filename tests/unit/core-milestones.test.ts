// The milestone hook on the document store, ported from Cloud's `rovara-code-milestones-hook.test.ts`. A milestone is one item in the task's partition, written in the transaction
// of the change that caused it; the handlers an adapter registers hear it after the commit, and again from the sweep while one of them has not.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, agentSessionKey, codeMilestoneKey, queryAll, type CodeMilestone, type DocumentStore } from "@agentx/contracts";
import {
  CODE_MILESTONE_ATTEMPTS_MAX, CODE_MILESTONE_DUE_PK, codeMilestoneItems, codeMilestoneWrittenFor, createDocumentMilestones, type CodeMilestoneHandler, type DocumentMilestones,
} from "../../packages/broker/src/core/milestones/milestones.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";

const orgId = IMPLICIT_COMPANY_ID;
const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const sessionId = "ses_aaaaaaaaaaaaaaaaaaaa";
const at = "2026-10-24T12:00:00.000Z";
const milestone = (overrides: Partial<CodeMilestone> = {}): CodeMilestone => ({ kind: "pr_ready", orgId, taskId, at, text: "The pull request is ready.", ...overrides });

let store: DocumentStore;
let clock: number;
let logs: Array<{ event: string; fields: Record<string, unknown> }>;
let hook: DocumentMilestones;
let off: Array<() => void>;
const commit = async (items: ReturnType<typeof codeMilestoneItems>): Promise<boolean> => (await store.transact(items)).applied;
const stored = () => queryAll(store, { pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "CODE_MILESTONE#" } });
const handler = (name: string, on: (m: CodeMilestone) => Promise<void> = async () => {}) => {
  const heard: CodeMilestone[] = [];
  const registered: CodeMilestoneHandler = { name, on: async (heardMilestone) => { heard.push(heardMilestone); await on(heardMilestone); } };
  off.push(hook.register(registered));
  return heard;
};

beforeEach(() => {
  store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES });
  clock = Date.parse(at);
  logs = [];
  off = [];
  hook = createDocumentMilestones({ store, now: () => clock, log: (event, fields) => { logs.push({ event, fields }); } });
});
afterEach(() => { for (const remove of off) remove(); });

describe("writing a milestone", () => {
  it("is one put that only succeeds when absent, in the task's partition, with Cloud's key", () => {
    const items = codeMilestoneItems(milestone(), 1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "put", condition: { op: "notExists", path: ["pk"] }, item: { ...codeMilestoneKey(taskId, "pr_ready", 1), entityType: "CODE_MILESTONE", orgId, taskId, kind: "pr_ready", text: "The pull request is ready." } });
  });

  it("stores one item when the same milestone is written in two transactions", async () => {
    expect(await commit(codeMilestoneItems(milestone(), 1))).toBe(true);
    expect(await commit(codeMilestoneItems(milestone({ text: "Same, again." }), 1))).toBe(false);
    expect(await stored()).toHaveLength(1);
    expect((await stored())[0]).toMatchObject({ text: "The pull request is ready." });
    // The next occurrence of the same kind is another milestone.
    expect(await commit(codeMilestoneItems(milestone(), 2))).toBe(true);
    expect(await stored()).toHaveLength(2);
  });

  it("adds a session event in the same transaction when the milestone names a session, and the same event on a repeat", () => {
    const items = codeMilestoneItems(milestone({ sessionId }), 1);
    expect(items).toHaveLength(2);
    const event = (items[1] as { item: Record<string, unknown> }).item;
    expect(event).toMatchObject({ pk: agentSessionKey(orgId, sessionId, "META").pk, orgId, sessionId, type: "status", text: "The pull request is ready." });
    expect(String(event["sk"])).toMatch(/^EVENT#/u);
    expect(((codeMilestoneItems(milestone({ sessionId }), 1)[1]) as { item: Record<string, unknown> }).item["sk"]).toBe(event["sk"]);
    expect(((codeMilestoneItems(milestone({ sessionId }), 2)[1]) as { item: Record<string, unknown> }).item["sk"]).not.toBe(event["sk"]);
  });

  it("writes the sweep's due-time keys while a handler may still be owed, under its own partition", () => {
    const row = (codeMilestoneItems(milestone(), 1)[0] as { item: Record<string, unknown> }).item;
    expect(row["dispatchDuePk"]).toBe(CODE_MILESTONE_DUE_PK);
    expect(row["dispatchDueSk"]).toEqual(expect.stringContaining("#"));
    expect(row["deliveredAt"]).toBeUndefined();
    expect(typeof row["indexExpiresAt"]).toBe("number");
  });

  it("refuses a milestone no one could read", () => {
    expect(() => codeMilestoneItems(milestone({ text: "x".repeat(501) }), 1)).toThrow();
    expect(() => codeMilestoneItems(milestone(), -1)).toThrow();
  });

  it("refuses to decide for itself: a milestone before the pull request needs the task's definition version (fail closed)", () => {
    for (const kind of ["questions", "answered", "plan_ready"] as const) {
      expect(() => codeMilestoneItems(milestone({ kind }), 1)).toThrow(/definition version/u);
      expect(() => codeMilestoneItems(milestone({ kind }), 1, {})).toThrow(/definition version/u);
    }
    for (const kind of ["pr_ready", "review_nudge", "fixing", "stuck", "approved", "merged"] as const) expect(codeMilestoneItems(milestone({ kind }), 1)).toHaveLength(1);
  });

  it("is written before the pull request only for a 1.1.0 task, and after it for both", () => {
    for (const kind of ["questions", "answered", "plan_ready"] as const) {
      expect(codeMilestoneWrittenFor(kind, "1.1.0")).toBe(true);
      expect(codeMilestoneWrittenFor(kind, "1.0.0")).toBe(false);
      expect(codeMilestoneItems(milestone({ kind }), 1, { definitionVersion: "1.0.0" })).toEqual([]);
      expect(codeMilestoneItems(milestone({ kind }), 1, { definitionVersion: "1.1.0" })).toHaveLength(1);
    }
    for (const kind of ["pr_ready", "review_nudge", "fixing", "stuck", "approved", "merged"] as const) {
      expect(codeMilestoneWrittenFor(kind, "1.0.0")).toBe(true);
      expect(codeMilestoneWrittenFor(kind, "1.1.0")).toBe(true);
    }
  });
});

describe("delivering milestones", () => {
  it("runs a registered handler once after the commit, and not again on a second delivery", async () => {
    const heard = handler("slack");
    await commit(codeMilestoneItems(milestone(), 1));
    await hook.deliver(taskId);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ kind: "pr_ready", taskId, text: "The pull request is ready." });
    await hook.deliver(taskId);
    expect(heard).toHaveLength(1);
    // Delivered: it leaves the sweep's index.
    expect((await stored())[0]?.["deliveredAt"]).toBeDefined();
    expect((await stored())[0]?.["dispatchDuePk"]).toBeUndefined();
  });

  it("tells each handler, in the order registered, and keeps one handler's failure from the others", async () => {
    const order: string[] = [];
    const first = handler("first", async () => { order.push("first"); throw new Error("down"); });
    const second = handler("second", async () => { order.push("second"); });
    await commit(codeMilestoneItems(milestone(), 1));
    await hook.deliver(taskId);
    expect(order).toEqual(["first", "second"]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // The failed handler's claim holds for a lease; once it lapsed, only the handler that failed is told again.
    clock += 61_000;
    await hook.deliver(taskId);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
  });

  it("retries a throwing handler and stops after 5 runs, logging each failure without its message", async () => {
    expect(CODE_MILESTONE_ATTEMPTS_MAX).toBe(5);
    const heard = handler("broken", async () => { throw new Error("secret-token-xyz"); });
    await commit(codeMilestoneItems(milestone(), 1));
    for (let round = 0; round < 8; round += 1) await hook.deliver(taskId);
    expect(heard).toHaveLength(5);
    const failures = logs.filter((entry) => entry.event === "code_milestone.handler_failed");
    expect(failures).toHaveLength(5);
    expect(failures[0]?.fields).toMatchObject({ taskId, kind: "pr_ready", handler: "broken", error: "Error" });
    expect(JSON.stringify(logs)).not.toContain("secret-token-xyz");
    // Given up on: it is no longer owed, so the sweep stops reading it.
    expect((await stored())[0]?.["dispatchDuePk"]).toBeUndefined();
  });

  it("does not run a handler twice when two deliveries meet", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const heard = handler("slow", async () => { await gate; });
    await commit(codeMilestoneItems(milestone(), 1));
    const meeting = [hook.deliver(taskId), hook.deliver(taskId)];
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all(meeting);
    expect(heard).toHaveLength(1);
  });

  it("takes up a handler that failed once, after its claim lapsed", async () => {
    let calls = 0;
    const heard = handler("flaky", async () => { calls += 1; if (calls === 1) throw new Error("x"); });
    await commit(codeMilestoneItems(milestone(), 1));
    await hook.deliver(taskId);
    clock += 61_000;
    await hook.deliver(taskId);
    expect(heard).toHaveLength(2);
    expect((await stored())[0]?.["deliveredAt"]).toBeDefined();
  });

  it("hears milestones in order and leaves another task's alone", async () => {
    const heard = handler("slack");
    const otherTask = "11111111-1111-4111-8111-111111111111";
    await commit(codeMilestoneItems(milestone({ kind: "plan_ready" }), 1, { definitionVersion: "1.1.0" }));
    await commit(codeMilestoneItems(milestone({ kind: "pr_ready" }), 1));
    await commit(codeMilestoneItems(milestone({ taskId: otherTask }), 1));
    await hook.deliver(taskId);
    expect(heard.map((entry) => entry.kind)).toEqual(["plan_ready", "pr_ready"].sort());
    expect(heard.every((entry) => entry.taskId === taskId)).toBe(true);
  });

  it("delivers nothing and leaves nothing owed when no handler is registered", async () => {
    await commit(codeMilestoneItems(milestone(), 1));
    await hook.deliver(taskId);
    expect((await stored())[0]?.["dispatchDuePk"]).toBeUndefined();
    expect((await stored())[0]?.["deliveredAt"]).toBeDefined();
  });

  it("refuses a handler registered twice under one name, and one named in a way that cannot be an attribute", () => {
    handler("same");
    expect(() => hook.register({ name: "same", on: async () => {} })).toThrow();
    expect(() => hook.register({ name: "Bad Name", on: async () => {} })).toThrow();
  });

  it("removes a handler with the function register gave back", async () => {
    const heard = handler("short_lived");
    off.pop()?.();
    await commit(codeMilestoneItems(milestone(), 1));
    await hook.deliver(taskId);
    expect(heard).toHaveLength(0);
  });

  it("skips an item that is not a readable milestone (a corrupt row is settled, not delivered)", async () => {
    const heard = handler("slack");
    await store.put({ item: { ...codeMilestoneKey(taskId, "merged", 1), entityType: "CODE_MILESTONE", kind: "deployed", taskId } });
    await hook.deliver(taskId);
    expect(heard).toHaveLength(0);
  });
});

describe("the sweep", () => {
  it("delivers a milestone whose handler was missed, and reads only milestones that are due", async () => {
    let up = false;
    const heard = handler("slack", async () => { if (!up) throw new Error("down"); });
    await commit(codeMilestoneItems(milestone(), 1));
    await hook.deliver(taskId);
    expect(heard).toHaveLength(1);
    // The failed handler is retried a minute later, not at once.
    clock += 1;
    expect(await hook.deliverDue()).toMatchObject({ attempted: 0 });
    up = true;
    clock += 10 * 60_000;
    expect(await hook.deliverDue()).toMatchObject({ attempted: 1 });
    expect(heard).toHaveLength(2);
    expect((await stored())[0]?.["deliveredAt"]).toBeDefined();
    clock += 10 * 60_000;
    expect(await hook.deliverDue()).toMatchObject({ attempted: 0 });
  });

  it("picks up a milestone nobody delivered after the commit", async () => {
    const heard = handler("slack");
    await commit(codeMilestoneItems(milestone(), 1));
    expect(await hook.deliverDue()).toMatchObject({ attempted: 1 });
    expect(heard).toHaveLength(1);
  });
});
