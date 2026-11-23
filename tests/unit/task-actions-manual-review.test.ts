import { describe, expect, it } from "vitest";
import { change, when } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { createTaskActions } from "../../packages/broker/src/core/task-flow/task-actions.js";
import { blockedReview, code, operationsOf, REQUEST_A, seed, stateOf, TASK_ID } from "../support/task-actions-world.js";

const ask = { requestId: REQUEST_A, instructions: "Check the empty case carefully.", expectedRevision: 6, candidateDigest: code.digest };

describe("manual core review: the retired workflow/review contract", () => {
  it("retries the exact checked candidate with the owner's note and answers a duplicate without another run", async () => {
    const { h, caller } = await seed();
    const actions = createTaskActions(h.deps);
    await actions.review(caller, TASK_ID, ask);
    const [operation] = await operationsOf(h);
    expect(operation).toMatchObject({ requestId: REQUEST_A, workflowMode: "REVIEW", dispatch: { payload: { workflowReviewNote: ask.instructions } } });
    await actions.review(caller, TASK_ID, ask);
    expect(await operationsOf(h)).toHaveLength(1);
    await expect(actions.review(caller, TASK_ID, { ...ask, instructions: "Other words" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it.each([
    { expectedRevision: 5 }, { candidateDigest: "f".repeat(64) }, { expectedRevision: undefined }, { candidateDigest: undefined },
  ])("refuses a stale or unbound blocked retry: %j", async (changed) => {
    const { h, caller } = await seed();
    const before = await stateOf(h);
    await expect(createTaskActions(h.deps).review(caller, TASK_ID, { ...ask, ...changed })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await stateOf(h)).toEqual(before);
  });

  it.each([
    { verification: { candidateDigest: "f".repeat(64), results: [{ checkId: "unit", status: "PASS" }], producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-11-10T10:00:00.000Z" } },
    { verification: { candidateDigest: code.digest, results: [{ checkId: "unit", status: "FAILED" }], producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-11-10T10:00:00.000Z" } },
  ])("starts no review without this candidate's passing checks", async (changed) => {
    const { h, caller } = await seed({ workflow: blockedReview(changed) });
    await expect(createTaskActions(h.deps).review(caller, TASK_ID, ask)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await operationsOf(h)).toHaveLength(0);
  });

  it("allows waiting review and holds the task's money cap", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({ state: "WAITING", blockReason: undefined }) });
    await expect(createTaskActions(h.deps, { roundCap: async () => ({ limitUsd: 1, spentUsd: 1 }) }).review(caller, TASK_ID, ask)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await operationsOf(h)).toHaveLength(0);
    await createTaskActions(h.deps).review(caller, TASK_ID, ask);
    expect(await operationsOf(h)).toHaveLength(1);
  });

  it("hides another company's task and a task the caller cannot own; script tokens never act", async () => {
    const { h, caller } = await seed();
    const before = await stateOf(h);
    for (const principal of [{ ...caller.principal, companyId: "org_another000000000000" }, { ...caller.principal, personId: "someone-else", roles: [] }]) {
      await expect(createTaskActions(h.deps).review({ principal }, TASK_ID, ask)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    }
    await expect(createTaskActions(h.deps).review({ ...caller, scriptToken: { tokenId: "x", name: "x", projects: ["payments"], permissions: [] } }, TASK_ID, ask)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await stateOf(h)).toEqual(before);
  });

  it("fences the owner's live authority into the review transaction", async () => {
    const { h, caller } = await seed({ access: { ...createOwnerTaskAccess(), ownerActing: async (_person, task) => ({ actorId: task.ownerKey, items: [{ kind: "check", key: { pk: "PROOF", sk: "META" }, condition: when.eq("revision", 1) }] }) } });
    await h.store.put({ item: { pk: "PROOF", sk: "META", revision: 2 } });
    await expect(createTaskActions(h.deps).review(caller, TASK_ID, ask)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(await operationsOf(h)).toHaveLength(0);
    await h.store.update({ key: { pk: "PROOF", sk: "META" }, ops: [change.set("revision", 1)] });
    await createTaskActions(h.deps).review(caller, TASK_ID, ask);
    expect(await operationsOf(h)).toHaveLength(1);
  });
});
