// The `scheduler` plug-in point (a new interface; both owners approve).
//
// A scheduler only says WHEN. A schedule names a time rule and a target; at each fire the scheduler tells ONE handler in Rovara's core
// (`subscribe`), and the core decides, from what is stored now, whether anything starts (the nightly test run does: it checks the project
// still has the schedule on, that something merged since the last run, that no run is in flight, and claims the slot before it starts
// anything). So a scheduler that fires twice, late, or after a restart does no harm: the core is idempotent per slot
// (`DueSchedule.slotId`), and a fire older than the schedule's own freshness window is not run.
//
//   - `put` creates or replaces a schedule. It is idempotent on (company, schedule id). `enabled: false` leaves it in place, off.
//   - `remove` deletes one (deleting what is not there is not an error). `get` reads one back.
//   - `subscribe` registers the one handler that hears of every fire. The handler resolves when it has HANDLED the fire (including by
//     deciding to start nothing). If it throws, the scheduler may deliver the same fire again (`attempt` counts), up to its own limit,
//     and then gives it up: the handler's fault is never swallowed into "done" by the scheduler.
//
// The time rule is a five-field cron (minute hour day-of-month month day-of-week; unix weekdays 0-6 with 7 also Sunday) in a named time
// zone, or "every N minutes". `capabilities` says which an adapter honours: Code's local timer runs UTC crons and intervals; Cloud's
// adapter (the cloud scheduler) also takes other zones. A rule an adapter does not honour is refused at `put`, never run differently.
import type { JsonObject } from "./json.js";

/** The most schedules one company may hold through this port per kind (an adapter may hold fewer). A guard against a loop, not a product limit. */
export const SCHEDULER_MAX_PER_COMPANY = 10_000;

export type ScheduleWhen =
  | { kind: "cron"; cron: string; timezone: string }
  | { kind: "every"; minutes: number };

export interface ScheduleEntry {
  companyId: string;
  /** Names the schedule within its company: letters, digits, `-` and `_`, 1 to 64 characters. */
  scheduleId: string;
  when: ScheduleWhen;
  enabled: boolean;
  /**
   * What the handler is given back, in the core's words (`nightly`, `chain`). Plain data that names ids only: a schedule is stored by an
   * outside system and listed in its console, so it never holds a secret or a person's text.
   */
  target: { kind: string; ref: JsonObject };
  /** The most a fire may be late and still be delivered (seconds). Past it the scheduler drops the fire. Default: one hour. */
  maxLateSeconds?: number;
  description?: string;
}

/** One fire. */
export interface DueSchedule {
  companyId: string;
  scheduleId: string;
  /** The time the rule meant (an ISO instant), not the time it was delivered. */
  scheduledAt: string;
  /** The same for every delivery of one fire (a retry, a restart): a hash of the company, the schedule and `scheduledAt`. */
  slotId: string;
  /** 1 for the first delivery of this fire. */
  attempt: number;
  target: ScheduleEntry["target"];
}

export interface SchedulerCapabilities {
  /** Time zones a cron may name (IANA names), or "any" when the adapter converts every zone. */
  timezones: readonly string[] | "any";
  /** The shortest interval, in minutes, that `every` accepts. */
  minEveryMinutes: number;
  /** A fire that was missed (the process was down) is delivered once, late, within `maxLateSeconds` (otherwise it is dropped). */
  deliversMissed: boolean;
}

export type SchedulerErrorCode =
  /** The rule or the id is not one this adapter runs. Never retried. */
  | "refused"
  /** The scheduler could not be reached. Retry later. */
  | "unavailable";

export class SchedulerError extends Error {
  constructor(readonly code: SchedulerErrorCode, message: string) {
    super(message);
    this.name = "SchedulerError";
  }
  get retryable(): boolean {
    return this.code === "unavailable";
  }
}

export interface ScheduleSubscription {
  stop(): Promise<void>;
}

export interface Scheduler {
  readonly capabilities: SchedulerCapabilities;
  put(spec: ScheduleEntry): Promise<void>;
  remove(companyId: string, scheduleId: string): Promise<boolean>;
  get(companyId: string, scheduleId: string): Promise<ScheduleEntry | undefined>;
  /** One handler per scheduler: a second subscription replaces the first. */
  subscribe(handler: (due: DueSchedule) => Promise<void>): ScheduleSubscription;
  close?(): Promise<void> | void;
}

const SCHEDULE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
/** Whether an id is one a scheduler may be given. */
export const isScheduleId = (value: string): boolean => SCHEDULE_ID.test(value);
