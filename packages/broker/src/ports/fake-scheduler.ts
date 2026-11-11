// The `scheduler` point: an in-memory scheduler for tests that fires only when the test says so (`fireForTest`), and the default that holds nothing.
//
// It keeps what it was given and honours the rules a real adapter must: ids are checked, a rule outside its capabilities is refused at `put`, a fire carries one slot id for every delivery,
// and a handler that throws is told the same fire again with `attempt` counted, up to `maxAttempts` (then the fire is dropped, as a real scheduler's retry limit does).
import { createHash } from "node:crypto";
import {
  SchedulerError, isScheduleId,
  type DueSchedule, type ScheduleEntry, type ScheduleSubscription, type Scheduler, type SchedulerCapabilities,
} from "@agentx/contracts";

export const FIVE_FIELD_CRON = /^\s*\S+(?:\s+\S+){4}\s*$/u;

/** The slot id of one fire: the same for every delivery of it. */
export function scheduleSlotId(companyId: string, scheduleId: string, scheduledAt: string): string {
  return createHash("sha256").update(JSON.stringify([companyId, scheduleId, new Date(scheduledAt).toISOString()])).digest("hex");
}

/** Refuses a spec an adapter with these capabilities could not run: the id, the rule, the zone and the interval. Shared by the adapters so each refuses the same way. */
export function checkScheduleEntry(spec: ScheduleEntry, capabilities: SchedulerCapabilities): void {
  if (!isScheduleId(spec.scheduleId)) throw new SchedulerError("refused", "not a schedule id");
  if (spec.when.kind === "cron") {
    if (!FIVE_FIELD_CRON.test(spec.when.cron)) throw new SchedulerError("refused", "the time is not a five-field cron");
    if (capabilities.timezones !== "any" && !capabilities.timezones.includes(spec.when.timezone)) throw new SchedulerError("refused", "this scheduler does not run that time zone");
  } else if (!Number.isInteger(spec.when.minutes) || spec.when.minutes < capabilities.minEveryMinutes) {
    throw new SchedulerError("refused", "that interval is shorter than this scheduler runs");
  }
  if (spec.maxLateSeconds !== undefined && (!Number.isInteger(spec.maxLateSeconds) || spec.maxLateSeconds < 1)) throw new SchedulerError("refused", "not a latest delivery time");
}

export interface FakeScheduler extends Scheduler {
  /** Plays one fire of a schedule: delivers it to the handler (retrying a throwing handler up to `maxAttempts`). Resolves with whether a delivery was handled. */
  fireForTest(companyId: string, scheduleId: string, scheduledAt: string): Promise<boolean>;
  all(): ScheduleEntry[];
}

export function createFakeScheduler(options: { capabilities?: Partial<SchedulerCapabilities>; maxAttempts?: number } = {}): FakeScheduler {
  const capabilities: SchedulerCapabilities = { timezones: ["UTC"], minEveryMinutes: 1, deliversMissed: false, ...options.capabilities };
  const maxAttempts = options.maxAttempts ?? 3;
  const held = new Map<string, ScheduleEntry>();
  const keyOf = (companyId: string, scheduleId: string): string => `${companyId}\u0000${scheduleId}`;
  let handler: ((due: DueSchedule) => Promise<void>) | undefined;
  return {
    capabilities,
    async put(spec) {
      checkScheduleEntry(spec, capabilities);
      held.set(keyOf(spec.companyId, spec.scheduleId), structuredClone(spec));
    },
    async remove(companyId, scheduleId) { return held.delete(keyOf(companyId, scheduleId)); },
    async get(companyId, scheduleId) {
      const found = held.get(keyOf(companyId, scheduleId));
      return found === undefined ? undefined : structuredClone(found);
    },
    subscribe(next): ScheduleSubscription {
      handler = next;
      return { async stop() { if (handler === next) handler = undefined; } };
    },
    async fireForTest(companyId, scheduleId, scheduledAt) {
      const spec = held.get(keyOf(companyId, scheduleId));
      if (spec === undefined || !spec.enabled || handler === undefined) return false;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await handler({ companyId, scheduleId, scheduledAt: new Date(scheduledAt).toISOString(), slotId: scheduleSlotId(companyId, scheduleId, scheduledAt), attempt, target: structuredClone(spec.target) });
          return true;
        } catch { /* the same fire is delivered again, as a real scheduler's retry would */ }
      }
      return false;
    },
    all: () => [...held.values()].map((spec) => structuredClone(spec)),
  };
}

/**
 * The default `scheduler` adapter: nothing is ever due. `put` is refused with `unavailable`, so a caller that needs a schedule (the nightly test run) says plainly that none is set up, instead of
 * keeping a schedule that never fires. `rovara up` registers the local timer.
 */
export function createUnavailableScheduler(): Scheduler {
  return {
    capabilities: { timezones: [], minEveryMinutes: Number.MAX_SAFE_INTEGER, deliversMissed: false },
    async put() { throw new SchedulerError("unavailable", "no scheduler is set up"); },
    async remove() { return false; },
    async get() { return undefined; },
    subscribe() { return { async stop() {} }; },
  };
}
