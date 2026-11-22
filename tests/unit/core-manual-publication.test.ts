import { describe, expect, it } from "vitest";
import { change, when } from "@agentx/contracts";
import { startManualPublication } from "../../packages/broker/src/core/task-flow/manual-publication.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { operationsOf, REQUEST_A, seed, TASK_ID } from "../support/task-actions-world.js";

const ask = { requestId: REQUEST_A, title: "Add retry", body: "Handle an empty response", draft: true };
describe("manual publication on core", () => {
  it("uses the pinned repository, claims the workspace, and replays the same operation", async () => {
    const { h, caller } = await seed({ workflow: null });
    const first = await startManualPublication(h.deps, caller, TASK_ID, ask);
    expect(first).toMatchObject({ kind: "publish", publication: { repository: "demo", title: ask.title, body: ask.body, draft: true }, dispatch: { extraActions: ["pull-request", "codebuild"] } });
    expect((await startManualPublication(h.deps, caller, TASK_ID, ask)).id).toBe(first.id);
    await expect(startManualPublication(h.deps, caller, TASK_ID, { ...ask, body: "Changed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await operationsOf(h)).toHaveLength(1);
  });
  it("refuses workflow bypass and a repository absent from the pinned project", async () => {
    const workflow = await seed();
    await expect(startManualPublication(workflow.h.deps, workflow.caller, TASK_ID, ask)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const { h, caller } = await seed({ workflow: null });
    await expect(startManualPublication(h.deps, caller, TASK_ID, { ...ask, repository: "new-repo" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await operationsOf(h)).toHaveLength(0);
  });
  it("hides foreign tasks and refuses script tokens, busy or closed tasks", async () => {
    const { h, caller } = await seed({ workflow: null });
    await expect(startManualPublication(h.deps, { principal: { ...caller.principal, companyId: "org_other00000000000000" } }, TASK_ID, ask)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(startManualPublication(h.deps, { ...caller, scriptToken: { tokenId: "x", name: "x", projects: ["payments"], permissions: [] } }, TASK_ID, ask)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    const busy = await seed({ workflow: null, workspace: { activeOperationId: "another", status: "BUSY" } });
    await expect(startManualPublication(busy.h.deps, busy.caller, TASK_ID, ask)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    const closed = await seed({ workflow: null, task: { closedAt: "2026-11-11T00:00:00.000Z" } });
    await expect(startManualPublication(closed.h.deps, closed.caller, TASK_ID, ask)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("fences live owner authority into acceptance", async () => {
    const { h, caller } = await seed({ workflow: null, access: { ...createOwnerTaskAccess(), ownerActing: async (_p, task) => ({ actorId: task.ownerKey, items: [{ kind: "check", key: { pk: "PROOF", sk: "META" }, condition: when.eq("revision", 1) }] }) } });
    await h.store.put({ item: { pk: "PROOF", sk: "META", revision: 2 } });
    await expect(startManualPublication(h.deps, caller, TASK_ID, ask)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(await operationsOf(h)).toHaveLength(0);
    await h.store.update({ key: { pk: "PROOF", sk: "META" }, ops: [change.set("revision", 1)] });
    await startManualPublication(h.deps, caller, TASK_ID, ask);
    expect(await operationsOf(h)).toHaveLength(1);
  });
});
