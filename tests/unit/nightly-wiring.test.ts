// The nightly joined to the ports: the schedule follows the approved environment and the scheduler's delivery reaches the fire.
import { describe, expect, it } from "vitest";
import { agentXError, type TestEnvironment } from "@agentx/contracts";
import { nightlyScheduleName } from "../../packages/broker/src/core/test-env/nightly.js";
import { fireTestEnvNightly, nightlyHooks, subscribeNightly } from "../../packages/broker/src/core/test-env/nightly-wiring.js";
import { createFakeScheduler } from "../../packages/broker/src/ports/fake-scheduler.js";
import { ORG, PROJECT, SCHEDULED, T0, body, nightlyWorld, rows } from "../support/nightly-world.js";

const ON = { ROVARA_NIGHTLY_HEALTH: "1" } as NodeJS.ProcessEnv;

describe("the schedule follows the approved environment", () => {
  const approved = (nightly: Partial<TestEnvironment["environment"]["nightly"]>): TestEnvironment => ({ revision: 1, approvedAt: new Date(T0).toISOString(), environment: body(nightly) });

  it("removes the project's schedule when the approved environment has it off, and makes none for a project that never had it on", async () => {
    const scheduler = createFakeScheduler();
    const hooks = nightlyHooks({ scheduling: { scheduler } }, ON);
    await hooks.onApproved(ORG, PROJECT, approved({ enabled: false }));
    expect(scheduler.all()).toEqual([]);
    await hooks.onApproved(ORG, PROJECT, approved({}));
    expect(scheduler.all()).toHaveLength(1);
    await hooks.onApproved(ORG, PROJECT, approved({ enabled: false }));
    expect(scheduler.all()).toEqual([]);
  });

  it("with the test environment off nothing is made, removed or asked, whatever the environment says", async () => {
    const scheduler = createFakeScheduler();
    let proved = 0;
    const hooks = nightlyHooks({ scheduling: { scheduler }, onProved: async () => { proved += 1; } }, { ROVARA_TEST_ENVIRONMENT: "0" });
    await hooks.onApproved(ORG, PROJECT, approved({}));
    expect(scheduler.all()).toEqual([]);
    expect(proved).toBe(0);
  });

  it("an install with no scheduler to ask makes nothing; a scheduler that says unavailable fails the call after the other step ran", async () => {
    await expect(nightlyHooks({}, ON).onApproved(ORG, PROJECT, approved({}))).resolves.toBeUndefined();
    let proved = 0;
    const down = createFakeScheduler();
    down.put = async () => { throw agentXError("RUNTIME_UNAVAILABLE", "scheduler down"); };
    const hooks = nightlyHooks({ scheduling: { scheduler: down }, onProved: async () => { proved += 1; } }, ON);
    await expect(hooks.onApproved(ORG, PROJECT, approved({}))).rejects.toThrow(/scheduler down/u);
    expect(proved).toBe(1);
    // A replay of an approval proves nothing new.
    await expect(hooks.onApproved(ORG, PROJECT, approved({}), { replayed: true })).rejects.toThrow(/scheduler down/u);
    expect(proved).toBe(1);
  });

});

describe("a delivery from the scheduler", () => {
  it("with the nightly off reads nothing, and with no way to start a run charges and claims nothing", async () => {
    const h = await nightlyWorld();
    expect(await fireTestEnvNightly(h.deps, h.due(), h.deps.runs, {})).toEqual({ outcome: "off" });
    expect(await fireTestEnvNightly(h.deps, h.due(), h.deps.runs, { ...ON, ROVARA_TEST_ENVIRONMENT: "0" })).toEqual({ outcome: "off" });
    expect(await fireTestEnvNightly(h.deps, h.due(), undefined, ON)).toEqual({ outcome: "skipped", reason: "run_unavailable" });
    expect(h.admitted).toEqual([]);
    expect(await rows(h.store, "TESTENV#NIGHTLY#")).toEqual([]);
  });

  it("reaches the fire through the subscription: the scheduler's delivery starts one run, and a second delivery of the same fire starts nothing", async () => {
    const h = await nightlyWorld();
    const scheduler = createFakeScheduler();
    const log: unknown[] = [];
    subscribeNightly({ scheduler, deps: h.deps, runs: h.deps.runs, env: ON, log: (entry) => log.push(entry) });
    await scheduler.put({ companyId: ORG, scheduleId: nightlyScheduleName(ORG, PROJECT), when: { kind: "cron", cron: "0 6 * * *", timezone: "UTC" }, enabled: true, target: { kind: "nightly", ref: { project: PROJECT } } });
    expect(await scheduler.fireForTest(ORG, nightlyScheduleName(ORG, PROJECT), SCHEDULED)).toBe(true);
    expect(await scheduler.fireForTest(ORG, nightlyScheduleName(ORG, PROJECT), SCHEDULED)).toBe(true);
    expect(h.started).toHaveLength(1);
    expect(log).toEqual([{ event: "test_env.nightly_fire", outcome: "started", attempt: 1 }, { event: "test_env.nightly_fire", outcome: "skipped", reason: "already_handled", attempt: 1 }]);
  });

  it("leaves another feature's schedule alone, and passes a fault that may pass to the scheduler so it delivers the fire again", async () => {
    const h = await nightlyWorld();
    const scheduler = createFakeScheduler();
    subscribeNightly({ scheduler, deps: h.deps, runs: h.deps.runs, env: ON });
    await scheduler.put({ companyId: ORG, scheduleId: "chain-1", when: { kind: "every", minutes: 5 }, enabled: true, target: { kind: "chain", ref: { chain: "x" } } });
    expect(await scheduler.fireForTest(ORG, "chain-1", SCHEDULED)).toBe(true);
    expect(h.started).toEqual([]);
    h.startFails.value = true;
    await scheduler.put({ companyId: ORG, scheduleId: nightlyScheduleName(ORG, PROJECT), when: { kind: "cron", cron: "0 6 * * *", timezone: "UTC" }, enabled: true, target: { kind: "nightly", ref: { project: PROJECT } } });
    expect(await scheduler.fireForTest(ORG, nightlyScheduleName(ORG, PROJECT), SCHEDULED)).toBe(false);
    h.startFails.value = false;
    expect(await scheduler.fireForTest(ORG, nightlyScheduleName(ORG, PROJECT), SCHEDULED)).toBe(true);
    expect(h.started).toHaveLength(1);
  });

});
