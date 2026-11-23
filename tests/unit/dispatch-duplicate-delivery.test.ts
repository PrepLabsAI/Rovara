import { describe, expect, it, vi } from "vitest";
import { CORE_DISPATCH_CLAIM_STALE_MS, change, MachineError, type ReceivedMessage } from "@agentx/contracts";
import { CORE_DISPATCH_VISIBILITY_TIMEOUT } from "../../infra/lib/core-engine.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { runDispatchOnce } from "../../packages/broker/src/core/task-flow/dispatch.js";
import { LambdaBatchQueue } from "../../packages/broker/src/aws/worker-machines/core-dispatch-host.js";
import type { OperationRecord, WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { COMPANY, createHarness, newRequestId, type Harness } from "../support/task-flow-harness.js";

const staleAfter = CORE_DISPATCH_CLAIM_STALE_MS / 1_000;
async function setup() {
  const lines: Record<string, unknown>[] = [];
  const h = createHarness({ machines: { startingChecks: 0 }, extra: () => ({ log: (line) => { lines.push(line); } }) });
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "private-payload-canary" });
  const view = await h.flow.get(h.owner, started.task.taskId);
  const key = operationKey(COMPANY, started.task.workspaceId, view.operations[0]!.id);
  return { h, key, lines, op: async () => (await h.store.get(key)) as unknown as OperationRecord };
}
async function duplicate(h: Harness, op: OperationRecord) {
  const queue = await h.queues.queue("task-dispatch");
  return queue.enqueue({ body: { v: 1, companyId: COMPANY, workspaceId: op.workspaceId, operationId: op.id } });
}
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

/** Real hosted batch adapter over the harness's queue clock, without AWS/network. */
async function hosted(h: Harness, visibility?: (handle: string, seconds: number) => Promise<boolean>) {
  const queue = await h.queues.queue("task-dispatch");
  const records = (await queue.receive()).map((message) => ({ messageId: message.messageId, receiptHandle: message.receiptHandle, body: JSON.stringify(message.body), attributes: { ApproximateReceiveCount: String(message.receiveCount) } }));
  const changeVisibility = vi.fn(async (handle: string, seconds: number) => {
    await (visibility ?? queue.changeVisibility.bind(queue))(handle, seconds);
  });
  const batch = new LambdaBatchQueue("task-dispatch", records, { changeVisibility });
  const ack = vi.spyOn(batch, "ack");
  const enqueue = vi.spyOn(batch, "enqueue");
  const run = () => runDispatchOnce({ ...h.deps, queues: { queue: async () => batch } });
  return { batch, ack, enqueue, changeVisibility, records, run };
}

describe("dispatch ownership", () => {
  it("hosted fresh duplicate stays unacknowledged until durable deferral and recovers a crashed claim exactly once", async () => {
    const { h, key, op, lines } = await setup();
    await h.store.update({ key, ops: [change.set("status", "DISPATCHING"), change.set("deliveredAt", new Date(h.clock.now).toISOString())] });
    h.clock.advance(4);
    const queue = await h.queues.queue("task-dispatch");
    const entered = barrier(), finish = barrier();
    const host = await hosted(h, async (handle, seconds) => { entered.release(); await finish.wait; return queue.changeVisibility(handle, seconds); });
    const post = vi.spyOn(h.machines, "deliver");
    const issue = vi.spyOn(CallbackCapabilities.prototype, "issue");
    try {
      const pending = host.run();
      await entered.wait;
      expect(host.ack).not.toHaveBeenCalled();
      expect(host.batch.failures()).toEqual(host.records.map((r) => r.messageId));
      finish.release();
      expect(await pending).toMatchObject({ retried: 1, dropped: 0, delivered: 0 });
      expect(host.ack).not.toHaveBeenCalled();
      expect(host.enqueue).not.toHaveBeenCalled();
      expect(host.changeVisibility).toHaveBeenCalledWith(host.records[0]!.receiptHandle, staleAfter - 4 + 1);
      expect(host.batch.failures()).toEqual(host.records.map((r) => r.messageId));
      expect(h.grants).toHaveLength(0);
      expect(issue).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(lines.some((line) => line.event === "task_flow.dispatch_fault")).toBe(false);
      expect(lines.at(-1)).toMatchObject({ decision: "defer-fresh-duplicate", receiveCount: 1 });
      h.clock.advance(staleAfter - 4);
      expect(await (await hosted(h)).run()).toMatchObject({ received: 0 });
      h.clock.advance(1);
      const recovery = await hosted(h);
      expect(recovery.records[0]!.messageId).toBe(host.records[0]!.messageId);
      expect(recovery.records[0]!.attributes.ApproximateReceiveCount).toBe("2");
      expect(await recovery.run()).toMatchObject({ delivered: 1, failed: 0 });
      expect(recovery.batch.failures()).toEqual([]);
      expect(await (await hosted(h)).run()).toMatchObject({ received: 0 });
      expect(h.grants).toHaveLength(1);
      expect(issue).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledTimes(1);
      expect((await op()).status).toBe("DISPATCHING");
    } finally { finish.release(); issue.mockRestore(); post.mockRestore(); }
  });

  it.each(["reject", "false"])("failed deferral (%s) never ACKs and leaves recovery possible", async (failure) => {
    const { h, key, op, lines } = await setup();
    await h.store.update({ key, ops: [change.set("status", "DISPATCHING"), change.set("deliveredAt", new Date(h.clock.now).toISOString())] });
    const before = await op();
    const host = await hosted(h, async () => { throw new Error("visibility unavailable"); });
    if (failure === "false") vi.spyOn(host.batch, "changeVisibility").mockResolvedValue(false);
    expect(await host.run()).toMatchObject({ retried: 1, delivered: 0, dropped: 0 });
    expect(host.ack).not.toHaveBeenCalled();
    expect(host.batch.failures()).toEqual(host.records.map((r) => r.messageId));
    expect(await op()).toEqual(before);
    expect(h.grants).toHaveLength(0);
    expect(lines.at(-1)).toMatchObject({ decision: "dispatch-fault" });
    expect(lines).toContainEqual(expect.objectContaining({ event: "task_flow.dispatch_fault" }));
    h.clock.advance(staleAfter + 1);
    expect(await (await hosted(h)).run()).toMatchObject({ delivered: 1 });
    expect(h.grants).toHaveLength(1);
  });

  it.each([0, 0.001, 86_400])("bounds fresh visibility with claim clock offset %s seconds", async (offset) => {
    const { h, key } = await setup();
    await h.store.update({ key, ops: [change.set("status", "DISPATCHING"), change.set("deliveredAt", new Date(h.clock.now + offset * 1_000).toISOString())] });
    h.clock.advance(staleAfter);
    const queue = await h.queues.queue("task-dispatch");
    const visibility = vi.spyOn(queue, "changeVisibility");
    expect(await h.flow.dispatchOnce()).toMatchObject({ retried: 1, delivered: 0 });
    expect(visibility).toHaveBeenCalledWith(expect.any(String), Math.min(43_200, Math.ceil(offset) + 1));
  });

  it("keeps at least one second of visibility if the clock advances during the fresh-claim check", async () => {
    const { h, key } = await setup();
    await h.store.update({ key, ops: [change.set("status", "DISPATCHING"), change.set("deliveredAt", new Date(h.clock.now).toISOString())] });
    h.clock.advance(staleAfter);
    let reads = 0;
    h.deps.now = () => new Date(h.clock.now + (++reads >= 3 ? 2_000 : 0));
    const host = await hosted(h);
    expect(await host.run()).toMatchObject({ retried: 1 });
    expect(host.changeVisibility).toHaveBeenCalledWith(host.records[0]!.receiptHandle, 1);
    expect(host.ack).not.toHaveBeenCalled();
    expect(h.grants).toHaveLength(0);
  });

  it.each(["deliveredAt", "updatedAt"])("logs a malformed %s claim and retains the message without credentials", async (field) => {
    const { h, key, op, lines } = await setup();
    await h.store.update({ key, ops: [change.set("status", "DISPATCHING"), change.set(field, "private-invalid-timestamp")] });
    const before = await op();
    const host = await hosted(h);
    expect(await host.run()).toMatchObject({ retried: 1, delivered: 0 });
    expect(host.ack).not.toHaveBeenCalled();
    expect(host.changeVisibility).not.toHaveBeenCalled();
    expect(host.batch.failures()).toHaveLength(1);
    expect(await op()).toEqual(before);
    expect(h.grants).toHaveLength(0);
    expect(lines).toContainEqual(expect.objectContaining({ event: "task_flow.dispatch_claim_invalid", operationId: before.id }));
    expect(JSON.stringify(lines)).not.toContain("private-invalid-timestamp");
  });

  it.each(["DISPATCHING", "RUNNING"] as const)("settles a fresh %s duplicate without a new grant, callback capability or worker POST", async (status) => {
    const { h, key, op, lines } = await setup();
    await h.flow.dispatchOnce();
    await h.store.update({ key, ops: [change.set("status", status)] });
    h.clock.advance(3);
    const before = await op();
    const grantCount = h.grants.length;
    const issue = vi.spyOn(CallbackCapabilities.prototype, "issue");
    const deliver = vi.spyOn(h.machines, "deliver");
    const health = vi.spyOn(h.machines, "health");
    try {
      const message = await duplicate(h, before);
      expect(await h.flow.dispatchOnce()).toMatchObject({ received: 1, dropped: status === "RUNNING" ? 1 : 0, retried: status === "RUNNING" ? 0 : 1, delivered: 0, failed: 0 });
      expect(await op()).toEqual(before);
      expect(h.grants).toHaveLength(grantCount);
      expect(issue).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      expect(health).not.toHaveBeenCalled();
      expect(lines.filter((line) => line.event === "task_flow.dispatch_delivery").at(-1)).toMatchObject({ operationId: before.id, attempt: before.fence, messageId: message.messageId, receiveCount: 1, stateAtReceipt: status, decision: status === "RUNNING" ? "ack-running" : "defer-fresh-duplicate" });
      expect(JSON.stringify(lines)).not.toContain("private-payload-canary");
      expect((await (await h.queues.queue("task-dispatch")).receive()).length).toBe(0);
      h.clock.advance(staleAfter + 1);
      expect((await (await h.queues.queue("task-dispatch")).receive()).length).toBe(status === "RUNNING" ? 0 : 1);
    } finally { issue.mockRestore(); deliver.mockRestore(); health.mockRestore(); }
  });

  it.each(["ACCEPTED", "DISPATCHING"] as const)("only one overlapping %s reader can claim and issue credentials", async (status) => {
    const { h, key, op } = await setup();
    if (status === "DISPATCHING") {
      // A crashed claimant never posted: a healthy idle machine cannot recover this through run-watch.
      await h.store.update({ key, ops: [change.set("status", status), change.set("deliveredAt", new Date(h.clock.now).toISOString())] });
      h.clock.advance(staleAfter + 1);
    }
    await duplicate(h, await op());
    const both = barrier(); let readers = 0;
    const health = h.machines.health.bind(h.machines);
    h.machines.health = async (id) => {
      if (++readers === 2) both.release();
      await both.wait;
      return health(id);
    };
    const reports = await Promise.all([h.flow.dispatchOnce({ maxMessages: 1 }), h.flow.dispatchOnce({ maxMessages: 1 })]);
    expect(reports.reduce((n, r) => n + r.delivered, 0)).toBe(1);
    expect(reports.reduce((n, r) => n + r.failed, 0)).toBe(0);
    expect(await op()).toMatchObject({ status: "DISPATCHING", deliveredAt: new Date(h.clock.now).toISOString() });
    expect(h.grants).toHaveLength(1);
    const workspace = (await h.store.get(workspaceKey(COMPANY, (await op()).workspaceId))) as unknown as WorkspaceRecord;
    expect(h.machines.delivered(workspace.machine!.machineId)).toHaveLength(1);
  });

  it("does not consult the machine after its workspace is closed before the machine can be remembered", async () => {
    const h = createHarness({ machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "closed before machine receipt" });
    const start = h.machines.start.bind(h.machines);
    h.machines.start = async (input) => {
      await h.flow.close(h.owner, started.task.taskId);
      return start(input);
    };
    const health = vi.spyOn(h.machines, "health");
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 0, dropped: 1 });
    expect(health).not.toHaveBeenCalled();
    expect(h.grants).toHaveLength(0);
  });

  it.each(["RUNNING", "DISPATCHING"])("rereads a concurrent %s winner only after the one atomic claim fails, without issuing credentials", async (status) => {
    const { h, key, op } = await setup();
    const get = h.store.get.bind(h.store);
    const transact = h.store.transact.bind(h.store);
    const events: string[] = [];
    h.store.get = async (readKey) => {
      if (readKey.pk === key.pk && readKey.sk === key.sk) events.push("read");
      return get(readKey);
    };
    h.store.transact = async (items) => {
      if (items.some((item) => item.kind === "update" && item.key.pk === key.pk && item.key.sk === key.sk)) {
        events.push("conditional-claim");
        // A real concurrent callback makes the condition fail in the same write.
        await h.store.update({ key, ops: [change.set("status", status)] });
        const result = await transact(items);
        expect(result.applied).toBe(false);
        events.push("condition-failed");
        return result;
      }
      return transact(items);
    };
    const issue = vi.spyOn(CallbackCapabilities.prototype, "issue");
    const post = vi.spyOn(h.machines, "deliver");
    try {
      expect(await h.flow.dispatchOnce()).toMatchObject({ dropped: status === "RUNNING" ? 1 : 0, retried: status === "RUNNING" ? 0 : 1, failed: 0, delivered: 0 });
      expect(events).toEqual(["read", "conditional-claim", "condition-failed", "read"]);
      expect(h.grants).toHaveLength(0);
      expect(issue).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect((await op()).status).toBe(status);
    } finally { issue.mockRestore(); post.mockRestore(); }
  });

  it.each(["ACCEPTED", "DISPATCHING"] as const)("refuses a %s snapshot whose operation fence changed before the single claim", async (status) => {
    const { h, key, op } = await setup();
    if (status === "DISPATCHING") {
      await h.store.update({ key, ops: [change.set("status", status), change.set("deliveredAt", new Date(h.clock.now).toISOString())] });
      h.clock.advance(staleAfter + 1);
    }
    const before = await op();
    const transact = h.store.transact.bind(h.store);
    let claims = 0;
    h.store.transact = async (items) => {
      if (items.some((item) => item.kind === "update" && item.key.pk === key.pk && item.key.sk === key.sk)) {
        claims += 1;
        await h.store.update({ key, ops: [change.set("fence", before.fence + 1)] });
      }
      return transact(items);
    };
    const issue = vi.spyOn(CallbackCapabilities.prototype, "issue");
    const post = vi.spyOn(h.machines, "deliver");
    try {
      expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 0, failed: 0 });
      expect(claims).toBe(1);
      expect(h.grants).toHaveLength(0);
      expect(issue).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(await op()).toMatchObject({ status, fence: before.fence + 1 });
    } finally { issue.mockRestore(); post.mockRestore(); }
  });

  it("keeps a refused claim's ACCEPTED operation retryable until it can be ended", async () => {
    const { h, op } = await setup();
    // The store refuses both the claim and the attempt to end it. ACKing merely
    // because a record exists would strand this accepted operation.
    h.store.transact = async () => ({ applied: false, reason: "condition_failed", failed: [0] });
    expect(await h.flow.dispatchOnce()).toMatchObject({ retried: 1, dropped: 0, delivered: 0 });
    expect((await op()).status).toBe("ACCEPTED");
    expect(h.grants).toHaveLength(0);
    h.clock.advance(60);
    expect((await (await h.queues.queue("task-dispatch")).receive())).toHaveLength(1);
  });

  it("keeps the claim fresh through visibility plus margin, then recovers a crash before POST", async () => {
    const { h, key, op, lines } = await setup();
    await h.store.update({ key, ops: [change.set("status", "DISPATCHING"), change.set("deliveredAt", new Date(h.clock.now).toISOString())] });
    h.clock.advance(staleAfter);
    expect(await h.flow.dispatchOnce()).toMatchObject({ retried: 1, delivered: 0 });
    expect(h.grants).toHaveLength(0);
    h.clock.advance(0.001);
    const message = await duplicate(h, await op());
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 1, failed: 0 });
    expect(lines.filter((line) => line.event === "task_flow.dispatch_delivery").at(-1)).toMatchObject({ operationId: (await op()).id, attempt: (await op()).fence, messageId: message.messageId, receiveCount: 1, stateAtReceipt: "DISPATCHING", decision: "recover-stale" });
  });

  it("defers visibility-timeout redelivery beyond freshness for crash recovery", async () => {
    const { h, key, op } = await setup();
    await h.store.update({ key, ops: [change.set("status", "DISPATCHING"), change.set("deliveredAt", new Date(h.clock.now).toISOString())] });
    h.clock.advance(CORE_DISPATCH_VISIBILITY_TIMEOUT.toSeconds());
    expect(await h.flow.dispatchOnce()).toMatchObject({ retried: 1, delivered: 0 });
    h.clock.advance(staleAfter - CORE_DISPATCH_VISIBILITY_TIMEOUT.toSeconds());
    expect(await h.flow.dispatchOnce()).toMatchObject({ received: 0, delivered: 0 });
    h.clock.advance(1);
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 1, failed: 0 });
    expect((await op()).status).toBe("DISPATCHING");
    expect(h.grants).toHaveLength(1);
  });

  it("uses the claim's deliveredAt even after another update refreshes updatedAt", async () => {
    const { h, key } = await setup();
    await h.store.update({ key, ops: [change.set("status", "DISPATCHING"), change.set("deliveredAt", new Date(h.clock.now).toISOString())] });
    h.clock.advance(staleAfter + 1);
    await h.store.update({ key, ops: [change.set("updatedAt", new Date(h.clock.now).toISOString())] });
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
  });

  it("recovers an old DISPATCHING record with no deliveredAt using its existing updatedAt", async () => {
    const { h, key, op } = await setup();
    await h.store.update({ key, ops: [change.set("status", "DISPATCHING")] });
    h.clock.advance(staleAfter + 1);
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    expect((await op()).status).toBe("DISPATCHING");
  });

  it.each(["rejected", "unauthorized"] as const)("still FAILS a real worker %s during stale recovery", async (code) => {
    const { h, key, op } = await setup();
    await h.store.update({ key, ops: [change.set("status", "DISPATCHING"), change.set("deliveredAt", new Date(h.clock.now).toISOString())] });
    h.clock.advance(staleAfter + 1);
    h.machines.deliver = async () => { throw new MachineError(code, "private-worker-text"); };
    expect(await h.flow.dispatchOnce()).toMatchObject({ failed: 1, delivered: 0 });
    expect((await op()).status).toBe("FAILED");
  });

  it("retains the existing retry budget across delayed recovery messages", async () => {
    const { h, op } = await setup();
    let posts = 0;
    h.machines.deliver = async () => { posts += 1; throw new MachineError("unavailable", "worker unreachable"); };
    for (let pass = 0; pass < 45; pass += 1) {
      await h.flow.dispatchOnce();
      if ((await op()).status === "FAILED") break;
      h.clock.advance(pass % 2 === 0 ? 70 : 151);
    }
    expect(await op()).toMatchObject({ status: "FAILED", error: "the worker machine did not become ready in time" });
    expect(posts).toBe(10);
  });

  it("ignores removed private recovery metadata and uses the native receive count", async () => {
    const { h, op } = await setup();
    const queue = await h.queues.queue("task-dispatch");
    const receive = queue.receive.bind(queue);
    queue.receive = async (options) => (await receive(options)).map((message) => ({ ...message, attributes: { ...message.attributes, dispatchReceives: "not-a-count" } }));
    expect(await h.flow.dispatchOnce()).toMatchObject({ failed: 0, delivered: 1 });
    expect((await op()).status).toBe("DISPATCHING");
    expect(h.grants).toHaveLength(1);
  });

  it("logs one dispatch decision for an initial delivery, and preserves message receive counts", async () => {
    const { h, lines, op } = await setup();
    const queue = await h.queues.queue("task-dispatch");
    const receive = queue.receive.bind(queue);
    let seen!: ReceivedMessage;
    queue.receive = async (options) => { const batch = await receive(options); seen = batch[0]!; return batch.map((m) => ({ ...m, receiveCount: 4 })); };
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    expect(lines.filter((line) => line.event === "task_flow.dispatch_delivery")).toEqual([{ companyId: COMPANY, component: "task-flow", event: "task_flow.dispatch_delivery", operationId: (await op()).id, attempt: (await op()).fence, messageId: seen.messageId, receiveCount: 4, stateAtReceipt: "ACCEPTED", decision: "dispatch" }]);
  });
});
