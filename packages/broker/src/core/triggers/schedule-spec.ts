// What a schedule trigger asks of the scheduler port: the time rule its spec means, the entry it is stored as, and whether the install's scheduler can run it.
import type { WEEKDAYS} from "@agentx/contracts";
import { type ScheduleEntry, type ScheduleTriggerSpec, type ScheduleWhen, type SchedulerCapabilities } from "@agentx/contracts";
import type { TriggerRecord } from "./store.js";

export const TRIGGER_SCHEDULE_KIND = "trigger";
export const triggerScheduleId = (triggerId: string): string => `trigger-${triggerId}`;
/** A fire older than this (seconds) is dropped by the scheduler. */
export const TRIGGER_SCHEDULE_MAX_LATE_SECONDS = 3_600;

const UNIX_DAY: Record<(typeof WEEKDAYS)[number], number> = { MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 0 };

/** The scheduler's rule for a schedule trigger's spec. */
export function scheduleWhen(spec: ScheduleTriggerSpec): ScheduleWhen {
  const { schedule } = spec;
  if (schedule.kind === "interval") return { kind: "every", minutes: schedule.minutes };
  const [hour, minute] = schedule.at.split(":").map((part) => String(Number(part)));
  if (schedule.kind === "daily") return { kind: "cron", cron: `${minute!} ${hour!} * * ${schedule.days === undefined ? "*" : schedule.days.map((day) => String(UNIX_DAY[day])).join(",")}`, timezone: spec.timezone };
  return { kind: "cron", cron: `${minute!} ${hour!} * * ${String(UNIX_DAY[schedule.day])}`, timezone: spec.timezone };
}

/** The schedule entry of a schedule trigger (running when `enabled`). */
export function scheduleEntryOf(trigger: TriggerRecord, enabled: boolean): ScheduleEntry {
  if (trigger.spec.kind !== "schedule") throw new Error("not a schedule trigger");
  return {
    companyId: trigger.orgId, scheduleId: triggerScheduleId(trigger.triggerId), when: scheduleWhen(trigger.spec), enabled, target: { kind: TRIGGER_SCHEDULE_KIND, ref: { orgId: trigger.orgId, triggerId: trigger.triggerId } },
    maxLateSeconds: TRIGGER_SCHEDULE_MAX_LATE_SECONDS, description: "A schedule trigger",
  };
}


/** Why the install's scheduler cannot run a schedule trigger's rule, in words; undefined when it can. A rule an adapter does not run is refused when the trigger is turned on, never run differently and never left waiting. */
export function scheduleRefusal(capabilities: SchedulerCapabilities, spec: ScheduleTriggerSpec): string | undefined {
  const when = scheduleWhen(spec);
  if (when.kind === "every") return when.minutes < capabilities.minEveryMinutes ? `this install's scheduler does not run an interval shorter than ${String(capabilities.minEveryMinutes)} minutes` : undefined;
  if (capabilities.timezones !== "any" && !capabilities.timezones.includes(when.timezone)) return `this install's scheduler runs schedules in ${capabilities.timezones.join(", ")} only, not ${when.timezone}; set the trigger's time zone to one of those`;
  return undefined;
}
