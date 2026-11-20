// A trigger runs what the owner turned on, and only that; and it shares the scheduler with the nightly run. The rules that matter:
//   1. turning a trigger on binds the version of its target: a proof read before a publish is refused after it; a publish (or an archive) turns every trigger of the target off, and a trigger that somehow missed that
//      is turned off at its next event, starting nothing;
//   2. a gate's proof is for the answer it names (continue is no proof to stop), and a proof is used once even by an approver that does not remember it;
//   3. the scheduler keeps one handler, so the install subscribes once through a router and each feature ignores the other's fires; a schedule the scheduler cannot run is refused when the trigger is turned on or made,
//      and one it refuses later turns the trigger off with the reason, never leaving it "on" and waiting;
//   4. one start per schedule slot even if the fire arrives again after the run is over.
import { describe, expect, it } from "vitest";
import { SchedulerError, type Approvers, type DueSchedule } from "@agentx/contracts";
import { createScheduleRouter } from "../../packages/broker/src/core/automation/schedule-router.js";
import { automationRequest, verifyOwnerProof } from "../../packages/broker/src/core/automation/authority.js";
import { createTrigger, enableTrigger, repairPendingSchedules, triggerEnableRequest } from "../../packages/broker/src/core/triggers/lifecycle.js";
import { chainGateRequest, decideChainGate } from "../../packages/broker/src/core/chains/gates.js";
import { startChainRun, onStepEnded } from "../../packages/broker/src/core/chains/runner.js";
import { approversOf } from "../support/automation-approvers.js";
import { COMPANY, OWNER, PROJECT, createAutomationWorld, publishAgent, publishChain, type AutomationWorld } from "../support/automation-world.js";

const PR = { kind: "event", source: "github", type: "pull_request.opened" } as const;
const EVERY_HOUR = { kind: "schedule", schedule: { kind: "interval", minutes: 60 }, timezone: "UTC", missed: "skip" } as const;

async function turnedOn(world: AutomationWorld, target: { kind: "agent"; agentId: string } | { kind: "chain"; chainId: string }, spec: unknown = PR) {
  const trigger = await createTrigger(world.dispatch, { orgId: COMPANY, target, project: PROJECT, spec, by: OWNER.personId });
  return enableTrigger(world.dispatch, COMPANY, trigger.triggerId, world.proofFor(await triggerEnableRequest(world.dispatch, trigger)));
}

describe("proofs", () => {
  const twoGates = (agentId: string) => ({
    start: "first",
    steps: [
      { kind: "agent", id: "first", name: "First", agent: { agentId, version: "current" }, next: { kind: "go", to: "ask" } },
      { kind: "gate", id: "ask", name: "Ask", prompt: "Go on?", approvers: [{ kind: "chain_owner" }], onApprove: { to: "$end" }, onReject: { to: "$end" } },
    ],
    limits: { maxRunUsd: 5 },
  });

  it("binds a gate's proof to its answer: a proof to continue is no proof to stop", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId, twoGates(agentId));
    const run = await startChainRun(world.chainRuns, { orgId: COMPANY, chainId: chainId, project: PROJECT, origin: "app", startedBy: { kind: "member", developerId: "d".repeat(64) }, owner: { developerId: OWNER.personId } });
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-1", status: "succeeded", report: "Done." });
    const approvers = approversOf();
    const toContinue = (await chainGateRequest(world.chainRuns, COMPANY, run.runId, 2, "approved")).request;
    await expect(decideChainGate(world.chainRuns, approvers, COMPANY, run.runId, 2, "declined", world.proofFor(toContinue))).rejects.toThrow(/not accepted/u);
    await decideChainGate(world.chainRuns, approvers, COMPANY, run.runId, 2, "approved", world.proofFor(toContinue));
    expect((await world.store.get({ pk: `ORG#${COMPANY}#CHAIN_RUN#${run.runId}`, sk: "STEP#0002" }))?.["decision"]).toBe("approved");
  });

  it("uses a proof up once, even for an approver that does not remember it", async () => {
    const world = createAutomationWorld();
    const stateless: Approvers = {
      async requirement() { return { methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: true }; },
      async verify() { return { approved: true, approver: OWNER, method: "local-session", proofId: "p-1" }; },
    };
    const request = automationRequest({ companyId: COMPANY, kind: "chain_gate", subjectId: "crn#1", revision: 1, facts: { a: 1 } });
    const proof = world.proofFor(request);
    const first = await verifyOwnerProof(stateless, request, proof);
    const second = await verifyOwnerProof(stateless, request, proof);
    expect((await world.store.transact([first.used])).applied).toBe(true);
    expect((await world.store.transact([second.used])).applied).toBe(false);
  });
});

describe("the scheduler", () => {

  it("runs every handler even if one throws, then fails the delivery so it is made again", async () => {
    const calls: string[] = [];
    let handler: ((due: DueSchedule) => Promise<void>) | undefined;
    const fake = { capabilities: { timezones: ["UTC"], minEveryMinutes: 1, deliversMissed: true }, put: async () => undefined, remove: async () => true, get: async () => undefined, subscribe: (h: (due: DueSchedule) => Promise<void>) => { handler = h; return { stop: async () => undefined }; } };
    const router = createScheduleRouter(fake);
    router.view.subscribe(async () => { calls.push("a"); throw new Error("first fails"); });
    router.view.subscribe(async () => { calls.push("b"); });
    router.start();
    await expect(handler!({ companyId: COMPANY, scheduleId: "s", scheduledAt: new Date().toISOString(), slotId: "x", attempt: 1, target: { kind: "trigger", ref: {} } })).rejects.toThrow("first fails");
    expect(calls).toEqual(["a", "b"]);
  });

  it("refuses to make or turn on a schedule the scheduler cannot run, and says what it can run", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const berlin = { kind: "schedule", schedule: { kind: "daily", at: "09:00" }, timezone: "Europe/Berlin", missed: "skip" };
    await expect(createTrigger(world.dispatch, { orgId: COMPANY, target: { kind: "agent", agentId }, project: PROJECT, spec: berlin, by: OWNER.personId })).rejects.toThrow(/runs schedules in UTC only, not Europe\/Berlin/u);
    // A trigger made while the scheduler could run it, and the scheduler's rules changed since: turning it on says so.
    const made = await createTrigger(world.dispatch, { orgId: COMPANY, target: { kind: "agent", agentId }, project: PROJECT, spec: EVERY_HOUR, by: OWNER.personId });
    const forced = await world.triggers.update({ trigger: made, patch: { spec: berlin as never } });
    await expect(enableTrigger(world.dispatch, COMPANY, forced.triggerId, world.proofFor(await triggerEnableRequest(world.dispatch, forced)))).rejects.toThrow(/UTC only/u);
    expect((await world.triggers.get(COMPANY, forced.triggerId))?.enabled).toBe(false);
  });

  it("turns a trigger off with the reason when the scheduler refuses its schedule, and does not retry it for ever", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    world.scheduler.refuse = "that rule is not one this scheduler runs";
    const on = await turnedOn(world, { kind: "agent", agentId }, EVERY_HOUR);
    const stored = await world.triggers.get(COMPANY, on.triggerId);
    expect(stored).toMatchObject({ enabled: false });
    expect(stored?.disabledReason).toMatch(/scheduler refused the schedule/u);
    expect(await world.triggers.listPendingSchedules(10)).toEqual([]);
    expect(await repairPendingSchedules(world.dispatch)).toBe(0);
  });

  it("keeps a trigger on and pending when the scheduler cannot be reached, and puts the schedule when it can", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const original = world.scheduler.put.bind(world.scheduler);
    world.scheduler.put = async () => { throw new SchedulerError("unavailable", "away"); };
    const on = await turnedOn(world, { kind: "agent", agentId }, EVERY_HOUR);
    expect(await world.triggers.get(COMPANY, on.triggerId)).toMatchObject({ enabled: true, scheduleStatus: "pending" });
    world.scheduler.put = original;
    expect(await repairPendingSchedules(world.dispatch)).toBe(1);
    expect(await world.triggers.get(COMPANY, on.triggerId)).toMatchObject({ scheduleStatus: "ok" });
  });
});
