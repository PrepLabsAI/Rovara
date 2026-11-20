// The local scheduler: the contract every scheduler passes, and the rules this one adds (UTC cron and intervals, missed fires, retries, restarts, one handler).
import { describe, expect, it } from "vitest";
import { SchedulerError, type DueSchedule, type ScheduleEntry } from "@agentx/contracts";
import { checkEntry, createIntervalScheduler, latestSlot, parseCron, slotIdOf, type IntervalScheduler } from "../../packages/local-adapters/src/interval-scheduler.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { checkScheduleEntry, createFakeScheduler, scheduleSlotId } from "../../packages/broker/src/ports/fake-scheduler.js";
import { runSchedulerConformance } from "../support/ports/scheduler-conformance.js";

const COMPANY = "org_00000000000000000000";
const START = Date.parse("2026-11-10T00:00:00.000Z");
const entry = (id: string, extra: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  companyId: COMPANY, scheduleId: id, when: { kind: "cron", cron: "30 2 * * *", timezone: "UTC" }, enabled: true, target: { kind: "nightly", ref: { project: "alpha" } }, ...extra,
});

function build(store = new MemoryDocumentStore(), clock = { at: START }, extra: { retryWaitsMs?: number[]; slept?: number[] } = {}): { scheduler: IntervalScheduler; clock: { at: number }; store: MemoryDocumentStore } {
  const scheduler = createIntervalScheduler({ store, now: () => clock.at, timer: false, sleep: async (ms) => { extra.slept?.push(ms); }, ...(extra.retryWaitsMs === undefined ? {} : { retryWaitsMs: extra.retryWaitsMs }) });
  return { scheduler, clock, store };
}

runSchedulerConformance("the local interval scheduler", {
  async create() {
    const { scheduler, clock } = build();
    return { scheduler, async fire(_spec, scheduledAt) { clock.at = Date.parse(scheduledAt) + 5_000; await scheduler.tick(); } };
  },
});

describe("the local interval scheduler", () => {
  it("agrees with the in-memory scheduler on ids, the slot id, zones and intervals", () => {
    expect(slotIdOf("c", "a", "2026-11-10T02:30:00Z")).toBe(scheduleSlotId("c", "a", "2026-11-10T02:30:00Z"));
    const fake = createFakeScheduler().capabilities;
    for (const id of ["ok-1", "", "a b", "x".repeat(65)]) {
      const mine = (() => { try { checkEntry(entry(id)); return true; } catch { return false; } })();
      const theirs = (() => { try { checkScheduleEntry(entry(id), fake); return true; } catch { return false; } })();
      expect(mine, id).toBe(theirs);
    }
    for (const when of [{ kind: "every", minutes: 0 }, { kind: "every", minutes: 5 }, { kind: "cron", cron: "0 4 * * *", timezone: "Europe/Paris" }] as const) {
      const mine = (() => { try { checkEntry(entry("x", { when })); return true; } catch { return false; } })();
      const theirs = (() => { try { checkScheduleEntry(entry("x", { when }), fake); return true; } catch { return false; } })();
      expect(mine).toBe(theirs);
    }
  });

  describe("cron", () => {
    const at = (text: string): number => Date.parse(text);
    it("reads lists, ranges and steps, and weekdays 0-6 with 7 as Sunday", () => {
      const every15 = parseCron("*/15 * * * *");
      expect([0, 15, 30, 45].every((minute) => every15.matches(at(`2026-11-10T03:${String(minute).padStart(2, "0")}:00Z`)))).toBe(true);
      expect(every15.matches(at("2026-11-10T03:16:00Z"))).toBe(false);
      expect(parseCron("5 1-3 * * *").matches(at("2026-11-10T02:05:00Z"))).toBe(true);
      expect(parseCron("5 1-3 * * *").matches(at("2026-11-10T04:05:00Z"))).toBe(false);
      expect(parseCron("0 0 * * 7").matches(at("2026-11-15T00:00:00Z"))).toBe(true); // a Sunday
      expect(parseCron("0 0 * * 0").matches(at("2026-11-15T00:00:00Z"))).toBe(true);
      expect(parseCron("0 0 * * 1").matches(at("2026-11-16T00:00:00Z"))).toBe(true); // a Monday
      expect(parseCron("0 0 10 11 *").matches(at("2026-11-10T00:00:00Z"))).toBe(true);
      expect(parseCron("0 0 10 12 *").matches(at("2026-11-10T00:00:00Z"))).toBe(false);
    });
    it("refuses what it cannot run: both day fields, names, out-of-range numbers and the wrong number of fields", () => {
      for (const cron of ["0 0 10 * 1", "0 0 * * MON", "60 0 * * *", "0 24 * * *", "0 0 0 * *", "0 0 * 13 *", "0 0 * * 8", "0 0 * *", "0 0 * * * *", "*/0 * * * *", "5-1 * * * *", ""]) {
        expect(() => parseCron(cron), cron).toThrow(SchedulerError);
      }
    });
  });

  it("finds the latest due slot of an interval from its anchor, and none before the anchor or at or before what was handled", () => {
    const anchor = START;
    const every = { kind: "every", minutes: 30 } as const;
    expect(latestSlot(every, anchor, anchor, anchor + 29 * 60_000, 3_600_000)).toBeUndefined();
    expect(latestSlot(every, anchor, anchor, anchor + 31 * 60_000, 3_600_000)).toBe(anchor + 30 * 60_000);
    expect(latestSlot(every, anchor, anchor + 30 * 60_000, anchor + 31 * 60_000, 3_600_000)).toBeUndefined();
    expect(latestSlot(every, anchor, anchor, anchor + 200 * 60_000, 3_600_000)).toBe(anchor + 180 * 60_000);
  });

  it("drops a fire later than the entry allows", async () => {
    const { scheduler, clock } = build();
    const heard: DueSchedule[] = [];
    scheduler.subscribe(async (due) => { heard.push(due); });
    await scheduler.put(entry("night", { maxLateSeconds: 600 }));
    clock.at = Date.parse("2026-11-10T02:41:00Z"); // eleven minutes after the 02:30 slot
    await scheduler.tick();
    expect(heard).toHaveLength(0);
    clock.at = Date.parse("2026-11-11T02:31:00Z");
    await scheduler.tick();
    expect(heard.map((due) => due.scheduledAt)).toEqual(["2026-11-11T02:30:00.000Z"]);
  });

  it("does not fire for a slot before the rule was put, and a changed rule starts afresh", async () => {
    const { scheduler, clock } = build();
    const heard: DueSchedule[] = [];
    scheduler.subscribe(async (due) => { heard.push(due); });
    clock.at = Date.parse("2026-11-10T02:40:00Z");
    await scheduler.put(entry("night")); // put after 02:30 today
    clock.at = Date.parse("2026-11-10T02:50:00Z");
    await scheduler.tick();
    expect(heard).toHaveLength(0);
    // Putting the same entry again keeps its place; changing the time moves it.
    await scheduler.put(entry("night"));
    await scheduler.put(entry("night", { when: { kind: "cron", cron: "55 2 * * *", timezone: "UTC" } }));
    clock.at = Date.parse("2026-11-10T02:56:00Z");
    await scheduler.tick();
    expect(heard.map((due) => due.scheduledAt)).toEqual(["2026-11-10T02:55:00.000Z"]);
  });

  it("tells the handler again with the attempt counted when it throws, waits between tries, and gives the fire up after three", async () => {
    const slept: number[] = [];
    const { scheduler, clock } = build(undefined, undefined, { slept });
    const attempts: number[] = [];
    scheduler.subscribe(async (due) => { attempts.push(due.attempt); throw new Error("no"); });
    await scheduler.put(entry("night"));
    clock.at = Date.parse("2026-11-10T02:31:00Z");
    await scheduler.tick();
    expect(attempts).toEqual([1, 2, 3]);
    expect(slept).toEqual([1_000, 5_000]);
    // Given up: the next tick does not start the same slot over.
    await scheduler.tick();
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("starts a timer on subscribe and stops it on close (an injected timer, no real waiting)", async () => {
    const started: number[] = [];
    let stopped = 0;
    let fire: (() => void) | undefined;
    const scheduler = createIntervalScheduler({ store: new MemoryDocumentStore(), now: () => START, timer: (everyMs, tick) => { started.push(everyMs); fire = tick; return { stop() { stopped += 1; } }; } });
    expect(started).toEqual([]);
    scheduler.subscribe(async () => undefined);
    scheduler.subscribe(async () => undefined);
    expect(started).toEqual([20_000]);
    fire?.();
    await scheduler.close?.();
    expect(stopped).toBe(1);
  });
});
