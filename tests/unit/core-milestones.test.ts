// The milestone hook on the document store, ported from Cloud's `rovara-code-milestones-hook.test.ts`. A milestone is one item in the task's partition, written in the transaction
// of the change that caused it; the handlers an adapter registers hear it after the commit, and again from the sweep while one of them has not.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, codeMilestoneKey, queryAll, type CodeMilestone, type DocumentStore } from "@agentx/contracts";
import {
  CODE_MILESTONE_ATTEMPTS_MAX, CODE_MILESTONE_DUE_PK, codeMilestoneItems, codeMilestoneWrittenFor, createDocumentMilestones, type CodeMilestoneHandler, type DocumentMilestones,
} from "../../packages/broker/src/core/milestones/milestones.js";
import { PendingMilestoneDelivery } from "../../packages/broker/src/core/milestones/pending-delivery.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";

const orgId = IMPLICIT_COMPANY_ID;
const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
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

  it("writes the sweep's due-time keys while a handler may still be owed, under its own partition", () => {
    const row = (codeMilestoneItems(milestone(), 1)[0] as { item: Record<string, unknown> }).item;
    expect(row["dispatchDuePk"]).toBe(CODE_MILESTONE_DUE_PK);
    expect(row["dispatchDueSk"]).toEqual(expect.stringContaining("#"));
    expect(row["deliveredAt"]).toBeUndefined();
    expect(typeof row["indexExpiresAt"]).toBe("number");
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

  it("refuses a handler registered twice under one name, and one named in a way that cannot be an attribute", () => {
    handler("same");
    expect(() => hook.register({ name: "same", on: async () => {} })).toThrow();
    expect(() => hook.register({ name: "Bad Name", on: async () => {} })).toThrow();
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
});

it.each(["pending", "Canvas closeout remains pending"])("review3: pending durable delivery keeps its row due beyond the ordinary failure limit (%s)", async (message) => {
  let pending = true;
  const heard = handler("cleanup", async () => { if (pending) throw new PendingMilestoneDelivery(message); });
  await commit(codeMilestoneItems(milestone({ kind: "closed" }), 1));
  for (let round = 0; round < CODE_MILESTONE_ATTEMPTS_MAX + 2; round++) {
    clock += 600_000;
    await hook.deliverDue();
    expect((await stored())[0]?.["deliveredAt"]).toBeUndefined();
    expect((await stored())[0]?.["dispatchDuePk"]).toBe(CODE_MILESTONE_DUE_PK);
  }
  expect(heard).toHaveLength(7);
  pending = false;
  clock += 600_000;
  expect(await hook.deliverDue()).toMatchObject({ attempted: 1 });
  expect((await stored())[0]?.["done_cleanup"]).toBe(true);
  expect((await stored())[0]?.["dispatchDuePk"]).toBeUndefined();
});


it("review4: pending cleanup survives later exceptions without refunding another handler's failures", async () => {
  let cleanupCalls = 0;
  let cleanupComplete = false;
  const cleanup: CodeMilestoneHandler = { name: "cleanup", on: async () => {
    cleanupCalls++;
    if (cleanupComplete) return;
    if (cleanupCalls === 1) throw new PendingMilestoneDelivery("pending");
    throw new Error("read unavailable");
  } };
  let ordinaryCalls = 0;
  const ordinary: CodeMilestoneHandler = { name: "ordinary", on: async () => { ordinaryCalls++; throw new Error("send unavailable"); } };
  hook.register(cleanup);
  hook.register(ordinary);
  await commit(codeMilestoneItems(milestone({ kind: "closed" }), 1));
  await hook.deliver(taskId);
  // Restart after learning that cleanup is owed: the state must be durable and handler-specific.
  hook = createDocumentMilestones({ store, now: () => clock });
  hook.register(cleanup);
  hook.register(ordinary);
  for (let round = 0; round < 6; round++) {
    clock += 600_000;
    expect(await hook.deliverDue()).toEqual({ attempted: 1 });
    expect((await stored())[0]?.["deliveredAt"]).toBeUndefined();
  }
  expect(cleanupCalls).toBe(7);
  expect(ordinaryCalls).toBe(5);
  cleanupComplete = true;
  clock += 600_000;
  expect(await hook.deliverDue()).toEqual({ attempted: 1 });
  expect((await stored())[0]?.["done_cleanup"]).toBe(true);
  expect((await stored())[0]?.["deliveredAt"]).toBeDefined();
  expect((await stored())[0]?.["dispatchDuePk"]).toBeUndefined();
});
