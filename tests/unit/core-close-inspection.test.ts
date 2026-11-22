import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { change, type TaskClosePreviewResponse } from "@agentx/contracts";
import { createHarness } from "../support/task-flow-harness.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { prepareCloseInspection, previewTaskClose } from "../../packages/broker/src/core/task-flow/close-inspection.js";

async function fixture() {
  const h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "inspection" });
  const wk = workspaceKey(h.deps.companyId, task.workspaceId);
  const workspace = (await h.store.get(wk))!;
  const operationId = workspace.activeOperationId;
  if (typeof operationId !== "string") throw new Error("fixture has no workspace holder");
  const op = operationKey(h.deps.companyId, task.workspaceId, operationId);
  await h.store.update({ key: op, ops: [change.set("kind", "close"), change.set("status", "RUNNING")] });
  const inspect = vi.fn(async () => ({ inspection: { safeToClose: false, repositories: [{ name: "demo", reasons: ["untracked_files"] }], contentDigest: "a".repeat(64) }, retentionId: "retained-1" }));
  const barrier = vi.fn(async () => {}), retained = vi.fn(async () => true);
  h.deps.closeInspection = { raiseFence: barrier, inspectWorkspaceForClose: inspect, retained };
  const preview = () => previewTaskClose(h.deps, h.owner, task.taskId, "discard");
  const prepare = () => prepareCloseInspection(h.deps, task.workspaceId, operationId);
  return { h, task, wk, op, inspect, barrier, retained, prepare, preview };
}
const digest = (r: TaskClosePreviewResponse) => r.preview?.digest;

describe("core retained close inspection (P1)", () => {
  it("persists the canonical inspection in the existing close OPERATION after the journal barrier", async () => {
    const w = await fixture(); expect(await w.prepare()).toBe(true);
    expect(w.barrier.mock.invocationCallOrder[0]).toBeLessThan(w.inspect.mock.invocationCallOrder[0]!);
    expect(await w.h.store.get(w.op)).toMatchObject({ kind: "close", status: "SUCCEEDED", result: { closeInspection: { schemaVersion: 1, retentionId: "retained-1", contentDigest: "a".repeat(64), repositories: [{ name: "demo", reasons: ["untracked_files"] }] } } });
    expect(await w.preview()).toMatchObject({ preview: { action: "discard", inspection: { operationId: w.op.sk.slice("OPERATION#".length), contentDigest: "a".repeat(64) }, unpublished: [{ repository: "demo", reasons: ["untracked_files"] }] } });
  });
  it("preview reads only: never inspect, raise, flush, dispatch or mutate a store", async () => {
    const w = await fixture(); await w.prepare(); w.inspect.mockClear(); w.barrier.mockClear();
    const writes = [vi.spyOn(w.h.store, "put"), vi.spyOn(w.h.store, "update"), vi.spyOn(w.h.store, "delete"), vi.spyOn(w.h.store, "transact")];
    expect(digest(await w.preview())).toMatch(/^[a-f0-9]{64}$/);
    expect(w.inspect).not.toHaveBeenCalled(); expect(w.barrier).not.toHaveBeenCalled();
    for (const spy of writes) expect(spy).not.toHaveBeenCalled();
  });
  for (const failure of ["missing", "barrier", "inspect", "partial", "oversized", "duplicate", "unproven"] as const) {
    it(`holds ${failure} inspection without a digest or invented empty list`, async () => {
      const w = await fixture();
      if (failure === "missing") delete w.h.deps.closeInspection;
      if (failure === "barrier") w.barrier.mockRejectedValue(new Error("barrier"));
      if (failure === "inspect") w.inspect.mockRejectedValue(new Error("read"));
      if (failure === "partial") w.inspect.mockResolvedValue({ inspection: { safeToClose: true, repositories: [], contentDigest: "" }, retentionId: "retained-1" });
      if (failure === "oversized") w.inspect.mockResolvedValue({ inspection: { safeToClose: false, repositories: Array.from({ length: 33 }, () => ({ name: "demo", reasons: ["untracked_files"] })), contentDigest: "a".repeat(64) }, retentionId: "retained-1" });
      if (failure === "duplicate") w.inspect.mockResolvedValue({ inspection: { safeToClose: false, repositories: Array.from({ length: 2 }, () => ({ name: "demo", reasons: ["untracked_files"] })), contentDigest: "a".repeat(64) }, retentionId: "retained-1" });
      if (failure === "unproven") w.retained.mockResolvedValue(false);
      expect(await w.prepare()).toBe(false);
      expect(await w.preview()).toEqual({ preview: null, unavailable: "inspection_required" });
      expect((await w.h.store.get(w.op))?.result).toBeUndefined();
    });
  }
  it("never upgrades legacy reason-only, failed, or tampered stored results into consent", async () => {
    const w = await fixture(); await w.prepare();
    const saved = (await w.h.store.get(w.op))!;
    for (const patch of [{ status: "FAILED" }, { result: { safeToClose: true, repositories: [] } }, { fence: 99 }, { companyId: "other" }]) {
      await w.h.store.put({ item: { ...saved, ...patch } });
      expect(await w.preview()).toMatchObject({ preview: null });
    }
  });
  it("losing retained proof on restart or during preparation keeps the preview held", async () => {
    const w = await fixture(); await w.prepare();
    w.retained.mockResolvedValue(false);
    expect(await w.preview()).toEqual({ preview: null, unavailable: "inspection_required" });
    w.retained.mockRejectedValue(new Error("lost snapshot"));
    expect(await w.preview()).toEqual({ preview: null, unavailable: "inspection_required" });
  });
  it("workspace drift before persistence commits no inspection", async () => {
    const w = await fixture();
    w.retained.mockImplementation(async () => { await w.h.store.update({ key: w.wk, ops: [change.set("fence", 99)] }); return true; });
    expect(await w.prepare()).toBe(false);
    expect((await w.h.store.get(w.op))?.result).toBeUndefined();
  });
  it("needs the exact close holder, successful result and live company/role authority", async () => {
    const w = await fixture(); await w.prepare();
    const saved = (await w.h.store.get(w.wk))!;
    for (const patch of [{ activeOperationId: randomUUID() }, { activeOperationId: null }, { fence: 99 }, { companyId: "other" }]) {
      await w.h.store.put({ item: { ...saved, ...patch } });
      expect(await w.preview()).toMatchObject({ preview: null });
    }
    await w.h.store.put({ item: saved });
    await expect(previewTaskClose(w.h.deps, { principal: { ...w.h.owner.principal, companyId: "other" } }, w.task.taskId, "close")).rejects.toThrow();
    w.h.deps.access.canAct = async () => false;
    await expect(w.preview()).rejects.toThrow();
  });
  it("a high-water barrier without retained exclusivity cannot certify even an empty clean list", async () => {
    const w = await fixture();
    w.inspect.mockResolvedValue({ inspection: { safeToClose: true, repositories: [], contentDigest: "a".repeat(64) }, retentionId: "retained-1" });
    w.retained.mockResolvedValue(false);
    expect(await w.prepare()).toBe(false);
    expect(w.barrier).toHaveBeenCalled();
    expect(await previewTaskClose(w.h.deps, w.h.owner, w.task.taskId, "close")).toEqual({ preview: null, unavailable: "inspection_required" });
  });

  it("binds D's digest to actor/company/task/workspace, action, lifecycle, holder, fence and exact inspection list/content", async () => {
    const w = await fixture(); await w.prepare(); const a = digest(await w.preview()); expect(a).toMatch(/^[a-f0-9]{64}$/);
    const saved = (await w.h.store.get(w.op))!;
    const result = saved.result as { closeInspection: Record<string, unknown> };
    for (const patch of [{ contentDigest: "b".repeat(64) }, { repositories: [{ name: "demo", reasons: ["worktree_changes"] }] }]) {
      await w.h.store.put({ item: { ...saved, result: { closeInspection: { ...result.closeInspection, ...patch } } } });
      expect(digest(await w.preview())).not.toBe(a);
    }
    await w.h.store.put({ item: saved });
    expect(digest(await previewTaskClose(w.h.deps, w.h.owner, w.task.taskId, "close"))).not.toBe(a);
    await w.h.store.update({ key: w.op, ops: [change.set("usage", { total: 1 })] });
    expect(digest(await w.preview())).toBe(a);
    await expect(previewTaskClose(w.h.deps, w.h.guest, w.task.taskId, "discard")).rejects.toThrow();
  });
});
