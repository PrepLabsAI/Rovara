import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { E2EApplicationSelectionRecordSchema, requalifyHoldKey as holdKeyOf, WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX, WORKFLOW_AGENTX_ACTOR_ID, workflowApplicationRetryOffered, workflowSendBackOffered, type WorkflowSnapshot } from "@agentx/contracts";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { apiRowKey, startApplicationRound, type RoundBrokerHarness, type RoundOptions } from "../support/e2e-application-round-harness.js";
import { MAYA } from "../support/developer-task-broker.js";
import { workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";

// AUTOREQUALIFY (AR-3) on the real broker: new browser and API rounds wait while the test machine is being switched (and are never blocked by it), and a selection refused only because
// the machine was renewed is approved again once by Rovara itself (the owner's retry still does the same, and anything else that moved still needs the owner).

afterEach(async () => { vi.useRealTimers(); await disposeRealCandidates(); });

const requalifyHoldKey = () => holdKeyOf("linux-arm64-web-api-v1");
const AUTOFIX = { enabled: true, capUsd: 15, roundEstimateUsd: 3 };
const holdRow = (until: number, extra: Record<string, unknown> = {}) => ({ ...requalifyHoldKey(), entityType: "RUNTIME_REQUALIFY_HOLD", runId: randomUUID(), acquiredAt: new Date().toISOString(), until: new Date(until).toISOString(), ...extra });
const checksOperations = (harness: RoundBrokerHarness) => harness.db.find((item) => item.entityType === "OPERATION" && item.workflowMode === "CHECKS");
const dispatchRows = (harness: RoundBrokerHarness) => harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.kind === "CHECKS");
const taskOf = (harness: RoundBrokerHarness) => harness.db.find((item) => item.sk === "META" && String(item.pk).startsWith("DEVTASK#"))[0] as
  { workflow: WorkflowSnapshot & { e2e?: Record<string, unknown> }; taskId: string; autofixAsk?: { reason?: string; codes?: string[] } };
const sweep = (harness: RoundBrokerHarness) => harness.handler({ source: "agentx.workflow-dispatch-recovery" });
/** What a renewal does to the registered row the round runs on: the next generation of the same machine, same binding and capabilities. */
const renew = (generation: number) => (harness: RoundBrokerHarness) => harness.db.set({ ...harness.db.get(apiRowKey.pk, apiRowKey.sk)!, generation, qualifiedAt: new Date(Date.now() - 1_000).toISOString() });
const reapprovalsOf = (harness: RoundBrokerHarness) => (taskOf(harness).workflow.e2e!.applicationReapprovals ?? []) as Array<{ actorId: string; previous: { runtimeRowsDigest: string }; current: { runtimeRowsDigest: string } }>;

/** A round whose first dispatch is deferred or refused (the helper then throws): what the test needs is the harness `beforeDispatch` was handed. */
async function firstDispatch(options: RoundOptions & { before: (harness: RoundBrokerHarness) => void }) {
  let held: RoundBrokerHarness | undefined;
  const { before, ...rest } = options;
  await expect(startApplicationRound({ ...rest, beforeDispatch: (harness) => { held = harness; before(harness); } })).rejects.toThrow(/started 0 CHECKS operations/);
  return held!;
}

describe("a switch in progress defers new browser and API rounds, and never blocks them", () => {
  it("leaves the dispatch row due and the task waiting while the hold stands, then runs the round once the hold ends", async () => {
    const harness = await firstDispatch({ before: (h) => h.db.set(holdRow(Date.now() + 600_000)) });
    expect(taskOf(harness).workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
    expect(taskOf(harness).workflow.blockReason).toBeUndefined();
    expect(dispatchRows(harness)).toHaveLength(1);
    expect(checksOperations(harness)).toEqual([]);
    // The recovery sweep keeps trying and keeps deferring; the row's failure budget is not spent.
    await sweep(harness); await sweep(harness);
    expect(checksOperations(harness)).toEqual([]);
    expect(dispatchRows(harness)[0]!.attempts ?? 0).toBe(0);
    harness.db.delete(requalifyHoldKey().pk, requalifyHoldKey().sk);
    await sweep(harness);
    expect(checksOperations(harness)).toHaveLength(1);
    expect(taskOf(harness).workflow).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
  });

  it("looks again right before the round starts: a hold placed after the first look still stops it", async () => {
    const harness = await firstDispatch({ before: (h) => {
      const send = h.db.send.bind(h.db);
      let looks = 0;
      h.db.send = async (command) => {
        const key = (command as { input?: { Key?: { pk?: string; sk?: string } } }).input?.Key;
        const result = await send(command);
        // The first read of the hold finds none; the switch begins right after it.
        if (command.constructor.name === "GetCommand" && key?.pk === requalifyHoldKey().pk && key.sk === requalifyHoldKey().sk && (looks += 1) === 1) h.db.set(holdRow(Date.now() + 600_000));
        return result;
      };
    } });
    expect(checksOperations(harness)).toEqual([]);
    expect(taskOf(harness).workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
  });

  it("fences the hold into the round's own start: a hold placed after BOTH looks still refuses the start, and the row stays due without spending its failure budget", async () => {
    const harness = await firstDispatch({ before: (h) => {
      const send = h.db.send.bind(h.db);
      let looks = 0;
      h.db.send = async (command) => {
        const key = (command as { input?: { Key?: { pk?: string; sk?: string } } }).input?.Key;
        const result = await send(command);
        // Neither look finds a hold; the switch begins right after the second, before the start transaction commits.
        if (command.constructor.name === "GetCommand" && key?.pk === requalifyHoldKey().pk && key.sk === requalifyHoldKey().sk && (looks += 1) === 2) h.db.set(holdRow(Date.now() + 600_000));
        return result;
      };
    } });
    expect(checksOperations(harness)).toEqual([]);
    expect(taskOf(harness).workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
    expect(taskOf(harness).workflow.blockReason).toBeUndefined();
    expect(dispatchRows(harness)).toHaveLength(1);
    expect(dispatchRows(harness)[0]!.attempts ?? 0).toBe(0);
    harness.db.delete(requalifyHoldKey().pk, requalifyHoldKey().sk);
    await sweep(harness);
    expect(checksOperations(harness)).toHaveLength(1);
  });

  it("does not defer for a hold that has ended (a renewal that crashed), but defers for a row it cannot read as a hold", async () => {
    const ended = await startApplicationRound({ beforeDispatch: (h) => h.db.set(holdRow(Date.now() - 1)) });
    expect(ended.checksOperations()).toHaveLength(1);
    const unreadable = await firstDispatch({ before: (h) => h.db.set({ ...requalifyHoldKey(), runId: "not-a-uuid" }) });
    expect(checksOperations(unreadable)).toEqual([]);
    expect(taskOf(unreadable).workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
  });
});

describe("a selection refused only because the test machine was renewed", () => {
  it("is blocked with its own reason, offered as a retry and never as a send back, when automatic fixing is off; the owner's retry approves the plan again as the owner", async () => {
    const harness = await firstDispatch({ before: renew(5) });
    const workflow = taskOf(harness).workflow;
    expect(workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(workflow.blockReason).toContain(WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX);
    expect(workflow.blockReason!.length).toBeLessThanOrEqual(500);
    expect(workflowApplicationRetryOffered(workflow as never)).toBe(true);
    expect(workflowSendBackOffered(workflow as never)).toBe(false);
    expect(taskOf(harness).autofixAsk).toBeUndefined();
    const retried = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskOf(harness).taskId}/workflow/retry`, { requestId: randomUUID(), expectedRevision: workflow.revision, instructions: "Approve the plan again" });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(taskOf(harness).workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
    expect(E2EApplicationSelectionRecordSchema.parse(taskOf(harness).workflow.e2e!.applicationSelection).runtimeRows[0]).toMatchObject({ generation: 5 });
    expect(reapprovalsOf(harness)).toHaveLength(1);
    expect(reapprovalsOf(harness)[0]!.actorId).not.toBe(WORKFLOW_AGENTX_ACTOR_ID);
  });

  it("is approved again once by Rovara itself, recorded as its own decision, with no ask card", async () => {
    const harness = await firstDispatch({ brokerExtra: { autofix: AUTOFIX }, before: renew(5) });
    const workflow = taskOf(harness).workflow;
    expect(workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
    expect(workflow.blockReason).toBeUndefined();
    expect(reapprovalsOf(harness)).toHaveLength(1);
    expect(reapprovalsOf(harness)[0]!.current.runtimeRowsDigest).not.toBe(reapprovalsOf(harness)[0]!.previous.runtimeRowsDigest);
    expect(reapprovalsOf(harness)[0]!.actorId).toBe(WORKFLOW_AGENTX_ACTOR_ID);
    expect(E2EApplicationSelectionRecordSchema.parse(workflow.e2e!.applicationSelection).runtimeRows[0]).toMatchObject({ generation: 5 });
    expect(workflow.decisions.filter((decision) => decision.source === "AUTO_RETRY")).toMatchObject([{ actorRole: "AGENTX", actorId: WORKFLOW_AGENTX_ACTOR_ID }]);
    expect(taskOf(harness).autofixAsk).toBeUndefined();
    // The retry wrote a fresh dispatch row for the revision it created.
    expect(dispatchRows(harness).map((row) => row.workflowRevision)).toContain(workflow.revision);
  });

  it("is approved again only once: a second renewal asks the owner instead of looping", async () => {
    const harness = await firstDispatch({ brokerExtra: { autofix: AUTOFIX }, before: renew(5) });
    expect(taskOf(harness).workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
    renew(6)(harness);
    await sweep(harness);
    const after = taskOf(harness);
    expect(after.workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(after.workflow.blockReason).toContain(WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX);
    expect(after.autofixAsk).toMatchObject({ reason: "retry-limit", codes: ["runtime-renewed"] });
    expect(reapprovalsOf(harness)).toHaveLength(1);
  });

  it("is not approved again by Rovara when something else moved between the block and the retry: the test accounts the plan stands on", async () => {
    const config = { ...AUTOFIX, enabled: false };
    const harness = await firstDispatch({ brokerExtra: { autofix: config }, before: renew(5) });
    const blocked = taskOf(harness).workflow;
    expect(blocked.blockReason).toContain(WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX);
    // The approved selection stood on another account revision than the one the owner's re-approval would pin now.
    const task = harness.db.get(String(harness.db.find((item) => item.sk === "META" && String(item.pk).startsWith("DEVTASK#"))[0]!.pk), "META")!;
    const selection = (task.workflow as { e2e: { applicationSelection: Record<string, unknown> } }).e2e.applicationSelection;
    harness.db.set({ ...task, workflow: { ...(task.workflow as object), e2e: { ...(task.workflow as { e2e: object }).e2e, applicationSelection: { ...selection,
      accountRefs: [{ applicationId: "orders", profileId: "tester", revision: 1, definitionDigest: "a".repeat(64) }] } } } });
    config.enabled = true;
    harness.db.set((workflowDispatchItem("state", taskOf(harness).taskId, blocked.revision, "AUTOFIX", (blocked.candidate as { digest: string }).digest, new Date().toISOString()).Put as { Item: Record<string, unknown> }).Item);
    await sweep(harness);
    expect(taskOf(harness).workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED", revision: blocked.revision });
    expect(reapprovalsOf(harness)).toHaveLength(0);
    expect(taskOf(harness).workflow.decisions.filter((decision) => decision.source === "AUTO_RETRY")).toEqual([]);
  });

  it("is not approved again by Rovara when no runtime is ready any more: the ordinary block, and a person decides", async () => {
    const harness = await firstDispatch({ brokerExtra: { autofix: AUTOFIX }, before: (h) => {
      const row = h.db.get(apiRowKey.pk, apiRowKey.sk)!;
      h.db.set({ ...row, generation: 5, qualifiedAt: new Date(Date.now() - 1_000).toISOString(), state: "REVOKED" });
    } });
    const after = taskOf(harness);
    expect(after.workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(after.workflow.blockReason).not.toContain(WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX);
    expect(reapprovalsOf(harness)).toHaveLength(0);
    expect(after.autofixAsk).toMatchObject({ reason: "needs-a-person" });
  });
});
