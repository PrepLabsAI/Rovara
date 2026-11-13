// The `scheduler` point: the in-memory fake and the default pass the contract.
import { describe, expect, it } from "vitest";
import { PLUGIN_POINTS, PLUGIN_POINT_CARDINALITY, SchedulerError } from "@rovara-code/contracts";
import { createAdapterRegistry, createFakeScheduler, createUnavailableScheduler, registerCodeDefaults, scheduleSlotId } from "../../packages/core/src/ports/index.js";
import { runSchedulerConformance } from "../support/ports/scheduler-conformance.js";

runSchedulerConformance("the in-memory fake", {
  async create() {
    const scheduler = createFakeScheduler();
    return { scheduler, async fire(spec, scheduledAt) { await scheduler.fireForTest(spec.companyId, spec.scheduleId, scheduledAt); } };
  },
});

describe("the scheduler point", () => {
  it("is a point of one adapter; the default holds nothing and refuses a put with 'unavailable'", async () => {
    expect(PLUGIN_POINTS).toContain("scheduler");
    expect(PLUGIN_POINT_CARDINALITY.scheduler).toBe("one");
    const none = createUnavailableScheduler();
    await expect(none.put({ companyId: "c", scheduleId: "a", when: { kind: "every", minutes: 5 }, enabled: true, target: { kind: "x", ref: {} } })).rejects.toBeInstanceOf(SchedulerError);
    expect(await none.get("c", "a")).toBeUndefined();
    expect(await none.remove("c", "a")).toBe(false);
  });

  it("is registered as a default, replaced by a configured adapter", () => {
    const registry = createAdapterRegistry();
    registerCodeDefaults(registry, { priceTable: { currency: "USD", models: {} } });
    expect(registry.names("scheduler")).toEqual(["none"]);
    registry.register("scheduler", "fake", createFakeScheduler());
    expect(registry.names("scheduler")).toEqual(["fake"]);
  });

  it("makes one slot id for one fire however the time is written", () => {
    expect(scheduleSlotId("c", "a", "2026-11-10T02:30:00Z")).toBe(scheduleSlotId("c", "a", "2026-11-10T02:30:00.000Z"));
    expect(scheduleSlotId("c", "a", "2026-11-10T02:30:00Z")).not.toBe(scheduleSlotId("c", "b", "2026-11-10T02:30:00Z"));
    expect(scheduleSlotId("c", "a", "2026-11-10T02:30:00Z")).not.toBe(scheduleSlotId("d", "a", "2026-11-10T02:30:00Z"));
  });

  it("a fake holds a fire off when the handler keeps throwing, after its attempts", async () => {
    const scheduler = createFakeScheduler({ maxAttempts: 2 });
    let attempts = 0;
    scheduler.subscribe(async () => { attempts += 1; throw new Error("no"); });
    await scheduler.put({ companyId: "c", scheduleId: "a", when: { kind: "every", minutes: 5 }, enabled: true, target: { kind: "x", ref: {} } });
    expect(await scheduler.fireForTest("c", "a", "2026-11-10T02:30:00Z")).toBe(false);
    expect(attempts).toBe(2);
  });
});
