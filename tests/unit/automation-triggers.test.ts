// Triggers: an event or a schedule starts paid work with no person watching, so every gate is decided at the moment of the event, from what is stored now. The rules that matter:
//   1. while automation is off an event starts nothing and a schedule fire is a no-op;
//   2. a trigger is made OFF, and turning it ON needs the owner's proof for exactly what it is (a proof for another trigger, or for an older version of this one, is refused);
//   3. what Rovara did never starts what Rovara does; one start per event; the hourly and daily allowances hold; Admission is asked and a refusal is recorded by its code;
//   4. a trigger whose target no longer qualifies is turned off, not run;
//   5. a schedule fire is one start per slot, never overlaps the work it last started, and its late fires follow the trigger's `missed` rule.
import { describe, expect, it } from "vitest";
import { ORG_MAX_AUTONOMOUS_RUNS_PER_DAY, type TriggerEvent } from "@rovara-code/contracts";
import { dispatchTriggerEvent, requestIdFor, eventIdentity } from "../../packages/core/src/core/triggers/dispatch.js";
import { createTrigger, enableTrigger, recheckTriggersForTarget, triggerEnableRequest, turnOffTrigger, updateTrigger } from "../../packages/core/src/core/triggers/lifecycle.js";
import { handleScheduleFire, triggerScheduleHandler } from "../../packages/core/src/core/triggers/schedules.js";
import { scheduleWhen } from "../../packages/core/src/core/triggers/schedule-spec.js";
import { COMPANY, OWNER, PROJECT, createAutomationWorld, publishAgent, publishChain, type AutomationWorld } from "../support/automation-world.js";

const PR = { kind: "event", source: "github", type: "pull_request.opened" } as const;
const EVERY_HOUR = { kind: "schedule", schedule: { kind: "interval", minutes: 60 }, timezone: "UTC", missed: "skip" } as const;

function event(extra: Partial<TriggerEvent> = {}, key = "pr-1"): TriggerEvent {
  return {
    source: "github", type: "pull_request.opened", eventKey: key, occurredAt: "2026-11-10T10:00:00.000Z", project: PROJECT,
    subject: { kind: "pull_request", id: key, title: "Fix the thing", url: "https://github.com/examplehost/web/pull/1" }, fields: { label: ["bug"] }, actor: { kind: "external", id: "maya" }, ...extra,
  };
}

async function onTrigger(world: AutomationWorld, spec: unknown = PR, targetKind: "agent" | "chain" = "agent", extra: { maxRunsPerHour?: number } = {}) {
  const { agentId } = await publishAgent(world);
  const target = targetKind === "agent" ? { kind: "agent", agentId } : { kind: "chain", chainId: await publishChain(world, agentId) };
  const trigger = await createTrigger(world.dispatch, { orgId: COMPANY, target, project: PROJECT, spec, by: OWNER.personId, ...extra });
  const request = await triggerEnableRequest(world.dispatch, trigger);
  const on = await enableTrigger(world.dispatch, COMPANY, trigger.triggerId, world.proofFor(request));
  return { agentId, trigger: on };
}

describe("turning a trigger on", () => {
  it("makes it OFF, and refuses to turn it on without the owner's proof", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const trigger = await createTrigger(world.dispatch, { orgId: COMPANY, target: { kind: "agent", agentId }, project: PROJECT, spec: PR, by: OWNER.personId });
    expect(trigger.enabled).toBe(false);
    await expect(enableTrigger(world.dispatch, COMPANY, trigger.triggerId, undefined)).rejects.toThrow(/owner's approval/u);
    await expect(enableTrigger(world.dispatch, COMPANY, trigger.triggerId, world.proofFor(await triggerEnableRequest(world.dispatch, trigger), "script-token:abc"))).rejects.toThrow(/not accepted/u);
    expect((await world.triggers.get(COMPANY, trigger.triggerId))?.enabled).toBe(false);
  });

  it("binds the proof to the trigger as it is: another trigger's proof, or one from before a change, is refused", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const make = () => createTrigger(world.dispatch, { orgId: COMPANY, target: { kind: "agent", agentId }, project: PROJECT, spec: PR, by: OWNER.personId });
    const [first, second] = [await make(), await make()];
    await expect(enableTrigger(world.dispatch, COMPANY, second.triggerId, world.proofFor(await triggerEnableRequest(world.dispatch, first)))).rejects.toThrow(/not accepted/u);
    const stale = world.proofFor(await triggerEnableRequest(world.dispatch, first));
    await updateTrigger(world.dispatch, COMPANY, first.triggerId, { maxRunsPerHour: 30 });
    await expect(enableTrigger(world.dispatch, COMPANY, first.triggerId, stale)).rejects.toThrow(/not accepted/u);
  });

  it("uses a proof once, and refuses an edit to a trigger that is on", async () => {
    const world = createAutomationWorld();
    const { trigger } = await onTrigger(world);
    expect(trigger.enabled).toBe(true);
    await expect(updateTrigger(world.dispatch, COMPANY, trigger.triggerId, { maxRunsPerHour: 30 })).rejects.toThrow(/turn the trigger off/u);
    const off = await turnOffTrigger(world.dispatch, COMPANY, trigger.triggerId, "the owner");
    expect(off.enabled).toBe(false);
    // The same proof cannot turn it on again: the revision it names is gone.
    await expect(enableTrigger(world.dispatch, COMPANY, trigger.triggerId, world.proofFor(await triggerEnableRequest(world.dispatch, trigger)))).rejects.toThrow(/not accepted/u);
  });

  it("refuses to turn on a trigger whose target can't run, and says why", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world, { instructions: "Only a person starts me.", sequence: [{ id: "look", name: "Look", kind: "agent", workspace: "read" }], triggers: [{ kind: "person" }] }, "Person only");
    const trigger = await createTrigger(world.dispatch, { orgId: COMPANY, target: { kind: "agent", agentId }, project: PROJECT, spec: PR, by: OWNER.personId });
    await expect(enableTrigger(world.dispatch, COMPANY, trigger.triggerId, world.proofFor(await triggerEnableRequest(world.dispatch, trigger)))).rejects.toThrow(/can't be started by events/u);
  });

  it("makes nothing while automation is off", async () => {
    const world = createAutomationWorld({ on: false });
    await expect(createTrigger(world.dispatch, { orgId: COMPANY, target: { kind: "agent", agentId: "code-reviewer" }, project: PROJECT, spec: PR, by: OWNER.personId })).rejects.toThrow(/not on this install/u);
  });
});

describe("dispatching an event", () => {
  it("starts nothing while automation is off", async () => {
    const world = createAutomationWorld();
    await onTrigger(world);
    world.switchOn.value = false;
    expect(await dispatchTriggerEvent(world.dispatch, COMPANY, event())).toEqual([]);
    expect(world.starts).toHaveLength(0);
    expect(world.admissions).toHaveLength(0);
  });

  it("starts the agent's published version through Admission, with no approval and the trigger named, and once per event", async () => {
    const world = createAutomationWorld();
    const { trigger, agentId } = await onTrigger(world);
    const [outcome] = await dispatchTriggerEvent(world.dispatch, COMPANY, event());
    expect(outcome).toMatchObject({ outcome: "started", taskId: "task-1" });
    expect(world.admissions.map((entry) => entry.action)).toEqual(["automation.run"]);
    expect(world.starts[0]).toMatchObject({ project: PROJECT, agent: { agentId, version: 1 }, origin: "event", trigger: { kind: "event", triggerId: trigger.triggerId }, limits: { maxMinutes: 120 } });
    expect(JSON.stringify(world.starts[0])).not.toMatch(/approv|proof|token/iu);
    const [again] = await dispatchTriggerEvent(world.dispatch, COMPANY, event());
    expect(again).toMatchObject({ outcome: "duplicate", taskId: "task-1" });
    expect(world.starts).toHaveLength(1);
    expect(requestIdFor(eventIdentity(trigger.triggerId, "pr-1"))).toBe(world.starts[0]!.requestId);
  });

  it("carries the digest of the frozen recipe, so a starter never re-resolves a wider one", async () => {
    const world = createAutomationWorld();
    const { agentId } = await onTrigger(world);
    await dispatchTriggerEvent(world.dispatch, COMPANY, event());
    const { resolveAgentForAutonomousRun } = await import("../../packages/core/src/core/agents/roster.js");
    const { recipeDigest } = await import("@rovara-code/contracts");
    const frozen = await resolveAgentForAutonomousRun(world.roster, { orgId: COMPANY, project: PROJECT, agentId });
    expect(world.starts[0]?.recipeDigest).toBe(recipeDigest(frozen.recipe));
  });

  it("never starts what Rovara itself did, and checks the actor against Rovara's own accounts", async () => {
    const world = createAutomationWorld();
    await onTrigger(world);
    const own = await dispatchTriggerEvent(world.dispatch, COMPANY, event({ actor: { kind: "rovara" } }, "pr-own"));
    expect(own[0]).toMatchObject({ outcome: "skipped", reason: "caused_by_rovara" });
    const dispatch = { ...world.dispatch, rovaraActorIds: async () => new Set(["the-app[bot]"]) };
    const bot = await dispatchTriggerEvent(dispatch, COMPANY, event({ actor: { kind: "external", id: "the-app[bot]" } }, "pr-bot"));
    expect(bot[0]).toMatchObject({ outcome: "skipped", reason: "caused_by_rovara" });
    expect(world.starts).toHaveLength(0);
  });

  it("holds the trigger's allowance for the hour and the company's for the day", async () => {
    const world = createAutomationWorld();
    await onTrigger(world, PR, "agent", { maxRunsPerHour: 2 });
    const outcomes = [];
    for (const key of ["a", "b", "c"]) outcomes.push((await dispatchTriggerEvent(world.dispatch, COMPANY, event({ subject: { kind: "pull_request", id: key, title: "t" } }, key)))[0]);
    expect(outcomes.map((entry) => entry?.outcome === "skipped" ? entry.reason : entry?.outcome)).toEqual(["started", "started", "rate_limited"]);
    expect(world.starts).toHaveLength(2);
    expect(ORG_MAX_AUTONOMOUS_RUNS_PER_DAY).toBeGreaterThan(2);
  });

  it("does not start the same subject twice in a row", async () => {
    const world = createAutomationWorld();
    await onTrigger(world);
    const sameSubject = { kind: "pull_request", id: "7", title: "Fix the thing" } as const;
    await dispatchTriggerEvent(world.dispatch, COMPANY, event({ subject: sameSubject }, "k1"));
    const second = await dispatchTriggerEvent(world.dispatch, COMPANY, event({ subject: sameSubject }, "k2"));
    expect(second[0]).toMatchObject({ outcome: "skipped", reason: "recent_subject" });
  });

  it("records an Admission refusal by its code and starts nothing, and a fault that may pass is thrown for the sender to repeat", async () => {
    const world = createAutomationWorld();
    await onTrigger(world);
    world.refuseAdmission = { code: "budget_exhausted", message: "Words from the adapter." };
    const [refused] = await dispatchTriggerEvent(world.dispatch, COMPANY, event());
    expect(refused).toMatchObject({ outcome: "failed", reason: "BUDGET_EXCEEDED" });
    expect(JSON.stringify(refused)).not.toMatch(/Words from the adapter/u);
    world.refuseAdmission = undefined;
    world.starter.failWith = Object.assign(new Error("RUNTIME_UNAVAILABLE: away"), { code: "RUNTIME_UNAVAILABLE", statusCode: 503, name: "AgentXError" });
    await expect(dispatchTriggerEvent(world.dispatch, COMPANY, event({}, "pr-2"))).rejects.toThrow();
  });

  it("takes an event only for the trigger's own project, source, type and filter", async () => {
    const world = createAutomationWorld();
    await onTrigger(world, { ...PR, filter: { label: ["p1"] } });
    expect(await dispatchTriggerEvent(world.dispatch, COMPANY, event())).toEqual([]);
    expect(await dispatchTriggerEvent(world.dispatch, COMPANY, event({ fields: { label: ["P1"] } }, "pr-9"))).toHaveLength(1);
    expect(await dispatchTriggerEvent(world.dispatch, COMPANY, event({ project: "other" }, "pr-10"))).toEqual([]);
  });

  it("turns a trigger off, and starts nothing, when its target no longer qualifies", async () => {
    const world = createAutomationWorld();
    const { trigger, agentId } = await onTrigger(world);
    await world.agents.setArchived(COMPANY, agentId, true, OWNER.personId);
    const [outcome] = await dispatchTriggerEvent(world.dispatch, COMPANY, event());
    expect(outcome).toMatchObject({ outcome: "failed", reason: "trigger_invalid" });
    const stored = await world.triggers.get(COMPANY, trigger.triggerId);
    expect(stored).toMatchObject({ enabled: false });
    expect(stored?.disabledReason).toMatch(/archived/u);
    expect(world.starts).toHaveLength(0);
    expect((await world.triggers.listNotices(COMPANY, OWNER.personId))[0]?.text).toMatch(/was turned off/u);
  });

  it("rechecks every enabled trigger of a target after a change to it", async () => {
    const world = createAutomationWorld();
    const { trigger, agentId } = await onTrigger(world);
    await world.agents.setArchived(COMPANY, agentId, true, OWNER.personId);
    const turnedOff = await recheckTriggersForTarget(world.dispatch, COMPANY, { kind: "agent", agentId } as never);
    expect(turnedOff.map((entry) => entry.triggerId)).toEqual([trigger.triggerId]);
  });

  it("starts a chain's run for a chain trigger, as one run per event", async () => {
    const world = createAutomationWorld();
    await onTrigger(world, PR, "chain");
    const [first] = await dispatchTriggerEvent(world.dispatch, COMPANY, event());
    expect(first).toMatchObject({ outcome: "started" });
    expect(first?.runId).toMatch(/^crn_/u);
    expect(world.starts[0]).toMatchObject({ origin: "chain", limits: { maxRunUsd: 5 } });
    expect((await dispatchTriggerEvent(world.dispatch, COMPANY, event()))[0]).toMatchObject({ outcome: "duplicate", runId: first?.runId });
  });
});

describe("schedule triggers", () => {
  it("maps a schedule spec to the scheduler's rule", () => {
    expect(scheduleWhen({ kind: "schedule", schedule: { kind: "interval", minutes: 60 }, timezone: "UTC", missed: "skip" })).toEqual({ kind: "every", minutes: 60 });
    expect(scheduleWhen({ kind: "schedule", schedule: { kind: "daily", at: "09:05", days: ["MON", "SUN"] }, timezone: "Europe/Berlin", missed: "skip" })).toEqual({ kind: "cron", cron: "5 9 * * 1,0", timezone: "Europe/Berlin" });
    expect(scheduleWhen({ kind: "schedule", schedule: { kind: "weekly", at: "23:00", day: "FRI" }, timezone: "UTC", missed: "run_once" })).toEqual({ kind: "cron", cron: "0 23 * * 5", timezone: "UTC" });
  });

  it("puts a schedule when the trigger is turned on, and takes it away when it is turned off", async () => {
    const world = createAutomationWorld();
    const { trigger } = await onTrigger(world, EVERY_HOUR);
    expect([...world.scheduler.entries.keys()]).toEqual([`trigger-${trigger.triggerId}`]);
    expect(await world.triggers.get(COMPANY, trigger.triggerId)).toMatchObject({ enabled: true, scheduleStatus: "ok" });
    await turnOffTrigger(world.dispatch, COMPANY, trigger.triggerId, "the owner");
    expect(world.scheduler.entries.size).toBe(0);
  });

  it("starts one run per slot however often the fire is delivered, and not while the last run is still going", async () => {
    const world = createAutomationWorld();
    const { trigger } = await onTrigger(world, EVERY_HOUR, "chain");
    const sub = world.scheduler.subscribe(triggerScheduleHandler(world.dispatch));
    const id = `trigger-${trigger.triggerId}`;
    await world.scheduler.fire({ scheduleId: id, slotId: "slot-1" });
    await world.scheduler.fire({ scheduleId: id, slotId: "slot-1" });
    expect(world.starts).toHaveLength(1);
    // The first run is still open: the next slot is skipped, not started.
    world.clock.now += 3_600_000;
    await world.scheduler.fire({ scheduleId: id, slotId: "slot-2", scheduledAt: new Date(world.clock.now).toISOString() });
    expect(world.starts).toHaveLength(1);
    const activity = await world.triggers.listActivity(COMPANY, trigger.triggerId);
    expect(activity.map((entry) => entry.reason ?? entry.outcome)).toContain("previous_run_open");
    await sub.stop();
  });

  it("does nothing while automation is off, and drops a late fire of a trigger that says to skip what was missed", async () => {
    const world = createAutomationWorld();
    const { trigger } = await onTrigger(world, EVERY_HOUR);
    const id = `trigger-${trigger.triggerId}`;
    const due = { companyId: COMPANY, scheduleId: id, scheduledAt: new Date(world.clock.now - 3_000_000).toISOString(), slotId: "late", attempt: 1, target: world.scheduler.entries.get(id)!.target };
    expect(await handleScheduleFire(world.dispatch, due)).toMatchObject({ outcome: "skipped", reason: "missed" });
    world.switchOn.value = false;
    expect(await handleScheduleFire(world.dispatch, { ...due, slotId: "other" })).toBeUndefined();
    expect(world.starts).toHaveLength(0);
  });

  it("removes the schedule of a trigger that is gone, and refuses a fire that names another company", async () => {
    const world = createAutomationWorld();
    const { trigger } = await onTrigger(world, EVERY_HOUR);
    const id = `trigger-${trigger.triggerId}`;
    await world.triggers.delete({ trigger: (await world.triggers.get(COMPANY, trigger.triggerId))! });
    await handleScheduleFire(world.dispatch, { companyId: COMPANY, scheduleId: id, scheduledAt: new Date(world.clock.now).toISOString(), slotId: "s", attempt: 1, target: { kind: "trigger", ref: { orgId: COMPANY, triggerId: trigger.triggerId } } });
    expect(world.scheduler.entries.size).toBe(0);
    expect(await handleScheduleFire(world.dispatch, { companyId: COMPANY, scheduleId: id, scheduledAt: new Date().toISOString(), slotId: "s", attempt: 1, target: { kind: "trigger", ref: { orgId: "org_11111111111111111111", triggerId: trigger.triggerId } } })).toBeUndefined();
  });
});
