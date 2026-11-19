// The conformance suite every `scheduler` adapter must pass: the in-memory fake, Code's local timer, and Cloud's hosted scheduler adapter later.
import { describe, expect, it } from "vitest";
import { SchedulerError, type DueSchedule, type ScheduleEntry, type Scheduler } from "@agentx/contracts";

export interface SchedulerUnderTest {
  scheduler: Scheduler;
  /** Makes the adapter deliver one fire of a schedule now (a fake fires it; a timer is moved to the fire's minute). Resolves when the handler has been told (or has given up). */
  fire: (spec: ScheduleEntry, scheduledAt: string) => Promise<void>;
  dispose?: () => Promise<void>;
}
export interface SchedulerHarness {
  create(): Promise<SchedulerUnderTest>;
}

const COMPANY = "org_00000000000000000000";
const spec = (id: string, extra: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  companyId: COMPANY, scheduleId: id, when: { kind: "cron", cron: "30 2 * * *", timezone: "UTC" }, enabled: true, target: { kind: "nightly", ref: { project: "alpha" } }, ...extra,
});

export function runSchedulerConformance(name: string, harness: SchedulerHarness): void {
  async function withScheduler<T>(body: (under: SchedulerUnderTest) => Promise<T>): Promise<T> {
    const under = await harness.create();
    try { return await body(under); } finally { await under.dispose?.(); }
  }

  describe(`scheduler conformance: ${name}`, () => {
    it("holds what was put, replaces it on a second put, and deletes it without an error when it is gone", () => withScheduler(async ({ scheduler }) => {
      expect(await scheduler.get(COMPANY, "night-1")).toBeUndefined();
      await scheduler.put(spec("night-1"));
      expect((await scheduler.get(COMPANY, "night-1"))?.when).toEqual({ kind: "cron", cron: "30 2 * * *", timezone: "UTC" });
      await scheduler.put(spec("night-1", { when: { kind: "cron", cron: "0 4 * * *", timezone: "UTC" }, enabled: false }));
      const replaced = await scheduler.get(COMPANY, "night-1");
      expect(replaced?.when).toEqual({ kind: "cron", cron: "0 4 * * *", timezone: "UTC" });
      expect(replaced?.enabled).toBe(false);
      expect(await scheduler.remove(COMPANY, "night-1")).toBe(true);
      expect(await scheduler.remove(COMPANY, "night-1")).toBe(false);
      expect(await scheduler.get(COMPANY, "night-1")).toBeUndefined();
    }));

    it("keeps one company's schedule apart from another's with the same id", () => withScheduler(async ({ scheduler }) => {
      await scheduler.put(spec("same"));
      expect(await scheduler.get("org_11111111111111111111", "same")).toBeUndefined();
      expect(await scheduler.remove("org_11111111111111111111", "same")).toBe(false);
      expect(await scheduler.get(COMPANY, "same")).toBeDefined();
    }));

    it("refuses an id, a cron or an interval it cannot run, at put", () => withScheduler(async ({ scheduler }) => {
      for (const id of ["", "has space", "a/b", "x".repeat(65)]) await expect(scheduler.put(spec(id))).rejects.toMatchObject({ name: "SchedulerError", code: "refused" });
      await expect(scheduler.put(spec("bad-cron", { when: { kind: "cron", cron: "every night", timezone: "UTC" } }))).rejects.toBeInstanceOf(SchedulerError);
      await expect(scheduler.put(spec("bad-every", { when: { kind: "every", minutes: 0 } }))).rejects.toBeInstanceOf(SchedulerError);
      await expect(scheduler.put(spec("bad-zone", { when: { kind: "cron", cron: "0 4 * * *", timezone: "Not/AZone" } }))).rejects.toBeInstanceOf(SchedulerError);
    }));

    it("tells the one handler about a fire: its target, one slot id however often it is delivered, and the time the rule meant", () => withScheduler(async ({ scheduler, fire }) => {
      const heard: DueSchedule[] = [];
      scheduler.subscribe(async (due) => { heard.push(due); });
      const night = spec("night-1");
      await scheduler.put(night);
      await fire(night, "2026-11-10T02:30:00.000Z");
      expect(heard).toHaveLength(1);
      expect(heard[0]).toMatchObject({ companyId: COMPANY, scheduleId: "night-1", scheduledAt: "2026-11-10T02:30:00.000Z", attempt: 1, target: { kind: "nightly", ref: { project: "alpha" } } });
      expect(heard[0]?.slotId).toMatch(/^[a-f0-9]{64}$/u);
    }));

    it("delivers nothing for a schedule that is off, and nothing after the subscription is stopped", () => withScheduler(async ({ scheduler, fire }) => {
      const heard: DueSchedule[] = [];
      const subscription = scheduler.subscribe(async (due) => { heard.push(due); });
      const off = spec("off", { enabled: false });
      await scheduler.put(off);
      await fire(off, "2026-11-10T02:30:00.000Z");
      expect(heard).toHaveLength(0);
      const on = spec("on");
      await scheduler.put(on);
      await subscription.stop();
      await fire(on, "2026-11-10T02:30:00.000Z");
      expect(heard).toHaveLength(0);
    }));

    it("delivers a fire again, with the attempt counted and the same slot id, when the handler threw (never counted as handled)", () => withScheduler(async ({ scheduler, fire }) => {
      const heard: DueSchedule[] = [];
      scheduler.subscribe(async (due) => { heard.push(due); if (due.attempt === 1) throw new Error("the handler failed once"); });
      const night = spec("night-1");
      await scheduler.put(night);
      await fire(night, "2026-11-10T02:30:00.000Z");
      expect(heard.map((due) => due.attempt)).toEqual([1, 2]);
      expect(new Set(heard.map((due) => due.slotId)).size).toBe(1);
    }));
  });
}
