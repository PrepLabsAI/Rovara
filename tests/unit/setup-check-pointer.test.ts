import { describe, expect, it } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { WORKER_INVOCATION_FEATURES, effectiveSetupAgentLimits } from "@agentx/contracts";
import { buildSetupCheck, relayCheck, setupStateOfCheck } from "../../packages/broker/src/core/setup-agent/check.js";
import { readWorkspaceMeta, workspaceCompanyReader } from "../../packages/broker/src/aws/worker-machines/workspace-company.js";
import { readOperation } from "../../packages/broker/src/core/task-flow/results.js";
import { startTask } from "../../packages/broker/src/core/task-flow/start.js";
import { locateWorkspace } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";

const companyId = "org_bbbbbbbbbbbbbbbbbbbb";
describe("setup check discovery", () => {
  it("hands the setup agent its job after preparation through the scoped workspace", async () => {
    const h = createHarness({ companyId, machines: { startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] } });
    await h.registerProject();
    const { task } = await startTask(h.deps, h.owner, { project: "payments", requestId: newRequestId(), instructions: "Set up payments" }, { setupAgent: { limits: effectiveSetupAgentLimits(), seenTaskId: undefined } });
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    const workspace = (await locateWorkspace(h.deps, task.workspaceId))!.workspace;
    const machine = workspace["machine"] as { machineId: string };
    const [prepare] = h.machines.delivered(machine.machineId);
    expect(prepare).toMatchObject({ kind: "prepare" });
    await h.flow.recordResult({ workspaceId: task.workspaceId, operationId: prepare!.operationId, fence: prepare!.fence, status: "SUCCEEDED", outcome: { kind: "prepared", base: [{ repositoryId: "demo", baseCommitSha: "b".repeat(40) }] } });
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    expect(h.machines.delivered(machine.machineId)[1]).toMatchObject({ kind: "task", payload: { workflowMode: "SETUP_AGENT", setupAgent: { commits: [{ repository: "demo", commit: "b".repeat(40) }] } } });
  });

  it.each([false, true])("dispatches and closes the company's check through its scoped records (candidate=%s)", async (candidate) => {
    const h = createHarness({ companyId, machines: { startingChecks: 0 } });
    await h.registerProject();
    const check = buildSetupCheck(h.deps, { project: "payments", revision: 1, startedBy: "local-owner", requestId: "dispatch", candidate });
    expect((await h.store.transact(check.items)).applied).toBe(true);
    await relayCheck(h.deps, check);
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    const workspace = await readWorkspaceMeta({ send: async (command) => ({ Item: await h.store.get(command.input.Key as { pk: string; sk: string }) }) }, "state", check.workspaceId);
    expect(workspace?.key.pk).toBe(`ORG#${companyId}#WORKSPACE#${check.workspaceId}`);
    const machine = workspace?.item["machine"] as { machineId: string };
    const [job] = h.machines.delivered(machine.machineId);
    expect(job).toMatchObject({ workspaceId: check.workspaceId, operationId: check.operationId, kind: "prepare" });
    expect(await readOperation(h.deps, check.workspaceId, check.operationId)).toMatchObject({ companyId, status: "DISPATCHING" });
    await h.flow.recordResult({ workspaceId: check.workspaceId, operationId: check.operationId, fence: job!.fence, status: "FAILED", error: "setup step 0 (npm ci) failed: exit 1" });
    expect(await h.store.get(workspace!.key)).toMatchObject({ status: "CLOSED", closedFrom: "PREPARATION_FAILED" });
    expect(await h.machines.health(machine.machineId)).toMatchObject({ state: "terminated" });
    expect(await setupStateOfCheck(h.deps, check.mark, { revision: 1, setup: [], readiness: [] })).toMatchObject({ status: "failed" });
    expect(await h.store.get({ pk: `WORKSPACE#${check.workspaceId}`, sk: "META" })).toEqual({ pk: `WORKSPACE#${check.workspaceId}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId: check.workspaceId, companyId });
  });

  it.each([false, true])("creates a discoverable workspace atomically (candidate=%s)", async (candidate) => {
    const h = createHarness({ companyId });
    const check = buildSetupCheck(h.deps, { project: "payments", revision: 1, startedBy: "local-owner", requestId: "check", candidate });
    expect((await h.store.transact(check.items)).applied).toBe(true);
    const readCompany = workspaceCompanyReader({ send: async (command: unknown) => {
      if (!(command instanceof GetCommand)) throw new Error("unexpected command");
      return { Item: await h.store.get(command.input.Key as { pk: string; sk: string }) };
    } } as never, "state");
    expect(await readCompany(check.workspaceId)).toBe(companyId);
    // The discovery key is reserved in the same transaction: a collision must leave no scoped record.
    const collision = buildSetupCheck(h.deps, { project: "payments", revision: 1, startedBy: "local-owner", requestId: "collision", candidate });
    await h.store.put({ item: { pk: `WORKSPACE#${collision.workspaceId}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId: collision.workspaceId, companyId: "org_cccccccccccccccccccc" } });
    expect((await h.store.transact(collision.items)).applied).toBe(false);
    expect(await h.store.get({ pk: `ORG#${companyId}#WORKSPACE#${collision.workspaceId}`, sk: "META" })).toBeUndefined();
  });
});
