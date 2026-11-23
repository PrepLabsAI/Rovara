import { describe, expect, it, vi } from "vitest";
import { change, createWorkflowSnapshot, type WorkflowSnapshot } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { baselineStartItem, markWorkflowE2EBaselineUnavailable, readWorkflowE2EBaselineRecord, requestWorkflowE2EBaselineRound } from "../../packages/broker/src/core/e2e/baseline.js";
import { runBaselineRoundFirst, type BaselineDispatchPorts } from "../../packages/broker/src/core/e2e/application-baseline-dispatch.js";
import { failedBaseline } from "../support/e2e-scenario-results.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { planFixture, NOW, binding, webApiRow } from "../support/e2e-application-plan-fixtures.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";

async function world() {
  const store = new MemoryDocumentStore();
  const clock = { now: NOW };
  const state = { store, now: () => new Date(clock.now) };
  const fx = planFixture({});
  const evaluation = evaluateApplicationPlanApproval({ taskId: "t", intent: fx.intent, artifact: { id: "plan", sha256: "a".repeat(64) }, snapshot: fx.snapshot, setupProposal: fx.setup.proposal,
    setupApproval: fx.setup.setupApproval, policy: fx.policy, registeredRuntimes: [webApiRow("web")], runtimeCatalogId: "catalog", runtimeBinding: binding, now: NOW, accounts: { entries: fx.registry, mode: "approve", pinned: [] } });
  if (!evaluation.ok) throw new Error(evaluation.reason);
  const workflow: WorkflowSnapshot = { ...createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: new Date(NOW).toISOString() }),
    e2e: { required: true, contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64),
      currentGroupRunIds: [], resultRefs: [], applicationSelection: evaluation.selection } };
  const task = { taskId: workflow.taskId, workflow };
  await requestWorkflowE2EBaselineRound(state, task, { enabled: true });
  const effects: string[] = [];
  const ports: BaselineDispatchPorts = { start: async () => "STARTED", operation: async () => ({ id: "op", status: "RUNNING" }), activeOperationId: async () => "op",
    cancel: async (id) => { effects.push(`cancel:${id}`); }, settle: async () => { effects.push("settle"); } };
  const start = async () => store.transact([baselineStartItem(task, { operationId: "op", roundId: "round", admissionSha256: "e".repeat(64), baseCommitSha: "f".repeat(40),
    startedAt: new Date(clock.now).toISOString(), deadlineAt: new Date(clock.now + 60_000).toISOString() })]);
  return { state, task, clock, effects, ports, start };
}

describe("informational baseline dispatch", () => {
  it("starts a requested baseline first and keeps its verdict outside the candidate workflow", async () => {
    const w = await world();
    const before = structuredClone(w.task.workflow);
    w.ports.start = async () => { await w.start(); return "STARTED"; };
    expect(await runBaselineRoundFirst(w.state, w.task, w.ports)).toBe("WAIT");
    expect((await readWorkflowE2EBaselineRecord(w.state, w.task))?.state).toBe("STARTED");
    expect(w.task.workflow).toEqual(before);
  });
  it("cancels a timed-out baseline and bounds the wait for a worker that never confirms", async () => {
    const w = await world(); await w.start(); w.clock.now += 10 * 60_000;
    expect(await runBaselineRoundFirst(w.state, w.task, w.ports)).toBe("WAIT");
    expect(w.effects).toEqual(["cancel:op"]);
    w.clock.now += 21 * 60_000;
    expect(await runBaselineRoundFirst(w.state, w.task, w.ports)).toBe("STUCK");
    expect((await readWorkflowE2EBaselineRecord(w.state, w.task))?.reason).toBe("cancel-unconfirmed");
    expect(w.task.workflow.e2e?.failedRound).toBeUndefined();
  });
  it("consumes an owner's baseline Stop once, so an explicit retry can proceed", async () => {
    const w = await world(); await w.start();
    w.ports.operation = async () => ({ id: "op", status: "CANCELLED" });
    expect(await runBaselineRoundFirst(w.state, w.task, w.ports)).toBe("STOPPED");
    expect(await runBaselineRoundFirst(w.state, w.task, w.ports)).toBe("GO");
  });
  it("lets missing exports and read failures remain informational", async () => {
    const w = await world();
    w.ports.start = async () => { throw new Error("not-exported"); };
    expect(await runBaselineRoundFirst(w.state, w.task, w.ports)).toBe("GO");
    expect((await readWorkflowE2EBaselineRecord(w.state, w.task))?.state).toBe("UNAVAILABLE");
    expect(w.task.workflow.e2e?.qualifiedRound).toBeUndefined();
  });
});

it("settles a successful informational round before admitting the candidate", async () => {
  const w = await world(); await w.start();
  w.ports.operation = async () => ({ id: "op", status: "SUCCEEDED" });
  expect(await runBaselineRoundFirst(w.state, w.task, w.ports)).toBe("GO");
  expect(w.effects).toEqual(["settle"]);
});

it("consumes an unavailable owner's Stop exactly once", async () => {
  const w = await world(); await w.start();
  await markWorkflowE2EBaselineUnavailable(w.state, w.task, "stopped", { from: ["STARTED"], operationId: "op" });
  w.ports.operation = async () => ({ id: "op", status: "CANCELLED" });
  expect(await runBaselineRoundFirst(w.state, w.task, w.ports)).toBe("STOPPED");
  expect(await runBaselineRoundFirst(w.state, w.task, w.ports)).toBe("GO");
});

it("leaves a live baseline within its deadline running", async () => {
  const w = await world(); await w.start();
  expect(await runBaselineRoundFirst(w.state, w.task, w.ports)).toBe("WAIT");
  expect(w.effects).toEqual([]);
  expect((await readWorkflowE2EBaselineRecord(w.state, w.task))?.state).toBe("STARTED");
});

it("does not reload an operation for a recorded baseline", async () => {
  const w = await world(); await w.start();
  const row = (await w.state.store.query({ pk: `DEVTASK#${w.task.taskId}` })).items[0]!;
  await w.state.store.update({ key: { pk: row.pk, sk: row.sk }, ops: [change.set("state", "RECORDED"), change.set("baseline", toDocument(failedBaseline()))] });
  const operation = vi.spyOn(w.ports, "operation");
  expect(await runBaselineRoundFirst(w.state, w.task, w.ports)).toBe("GO");
  expect(operation).not.toHaveBeenCalled();
});

it("keeps an interrupted worker that still holds the workspace from admitting the candidate", async () => {
  const w = await world(); await w.start();
  w.ports.operation = async () => ({ id: "op", status: "INTERRUPTED" });
  expect(await runBaselineRoundFirst(w.state, w.task, w.ports)).toBe("STUCK");
  expect((await readWorkflowE2EBaselineRecord(w.state, w.task))?.reason).toBe("cancel-unconfirmed");
  expect(w.effects).toEqual([]);
});
