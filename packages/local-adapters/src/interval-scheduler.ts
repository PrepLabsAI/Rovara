// The local `scheduler` adapter: a timer inside the process that runs `rovara up`. It says WHEN and nothing else (see `contracts/src/ports/scheduler.ts`): at each fire it tells the one subscribed handler, and the core
// decides from what is stored then whether anything starts.
//
// What it keeps, in the injected document store (so a restart keeps every schedule): one row per schedule under the company's own partition (`ORG#<company>#SCHEDULER`, one row per schedule id) holding the
// entry, an ANCHOR (when the rule took effect: an interval counts from it, and a rule that changed is never fired for a slot before it) and the latest slot handled; and one small row per company that has a
// schedule, so a restart knows which companies to look at.
//
// What it promises, each one tested (tests/unit/interval-scheduler.test.ts):
//   - a tick looks at every enabled schedule once and delivers the LATEST slot that is due and not yet handled, once; slots older than the entry's `maxLateSeconds` (default one hour) are dropped, and a slot missed
//     while the process was down is delivered once, late, if it is still inside that window (`deliversMissed`);
//   - a handler that throws is told the same fire again with `attempt` counted, up to three times with a short wait, and then the fire is given up (the slot counts as handled, so a broken handler cannot
//     hold a schedule in a loop). A fire with no handler subscribed is not consumed: the next tick still finds it, while it is inside its window;
//   - cron is five fields in UTC (`minute hour day-of-month month day-of-week`; lists, ranges and steps; weekdays 0-6 with 7 also Sunday). A rule that sets both the day of the month and the day of the week
//     is refused, as the hosted scheduler refuses it. `every N minutes` counts from the anchor. Any other time zone is refused at `put`: this adapter never runs a rule differently from what it said;
//   - one handler at a time; a second `subscribe` replaces the first. Ticks never overlap. `close()` stops the timer and every later call finds nothing to do.
// The timer is `setInterval` (every 20 seconds by default, never keeps the process alive); tests give none and call `tick()` with their own clock.
import { createHash } from "node:crypto";
import {
  SchedulerError, companyScoped, isScheduleId, when,
  type DocumentKey, type DocumentStore, type DueSchedule, type StoredDocument, type ScheduleEntry, type ScheduleSubscription, type Scheduler, type SchedulerCapabilities,
} from "@agentx/contracts";

const MINUTE_MS = 60_000;
const DEFAULT_MAX_LATE_SECONDS = 3_600;
const DEFAULT_TICK_MS = 20_000;
/** The longest window a tick looks back over (a week of minutes): a bigger `maxLateSeconds` is cut to it, so a tick's work is bounded. */
const LOOK_BACK_MAX_MINUTES = 7 * 24 * 60;
const ATTEMPTS_MAX = 3;
const DEFAULT_RETRY_WAITS_MS = [1_000, 5_000] as const;
const COMPANIES_PARTITION = "SCHEDULER#COMPANIES";

export const INTERVAL_SCHEDULER_CAPABILITIES: SchedulerCapabilities = { timezones: ["UTC"], minEveryMinutes: 1, deliversMissed: true };

// ---- the rule

const FIELD = /^[0-9*/,-]+$/u;
const FIVE_FIELDS = /^\s*\S+(?:\s+\S+){4}\s*$/u;

function expand(field: string, min: number, max: number): ReadonlySet<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const step = /^(\*|\d+(?:-\d+)?)\/(\d+)$/u.exec(part);
    const range = /^(\d+)-(\d+)$/u.exec(part);
    let from: number, to: number, by: number;
    if (step !== null) {
      by = Number(step[2]);
      if (step[1] === "*") { from = min; to = max; } else { const [low, high] = step[1]!.split("-"); from = Number(low); to = high === undefined ? max : Number(high); }
    } else if (range !== null) { from = Number(range[1]); to = Number(range[2]); by = 1; }
    else if (/^\d+$/u.test(part)) { from = Number(part); to = from; by = 1; }
    else if (part === "*") { from = min; to = max; by = 1; }
    else throw new SchedulerError("refused", "the time is not a cron this scheduler can run");
    if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(by) || by < 1 || from < min || to > max || from > to) throw new SchedulerError("refused", "the time is not a cron this scheduler can run");
    for (let value = from; value <= to; value += by) out.add(value);
  }
  return out;
}

export interface CronMatcher { matches(atMs: number): boolean }

/** Reads a five-field cron (UTC). Throws `SchedulerError` `refused` for one it cannot run, including one that sets both the day of the month and the day of the week. */
export function parseCron(cron: string): CronMatcher {
  if (!FIVE_FIELDS.test(cron)) throw new SchedulerError("refused", "the time is not a five-field cron");
  const fields = cron.trim().split(/\s+/u);
  if (!fields.every((field) => FIELD.test(field))) throw new SchedulerError("refused", "the time is not a cron this scheduler can run");
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (dom !== "*" && dow !== "*") throw new SchedulerError("refused", "set the day of the month or the day of the week, not both");
  const minutes = expand(minute, 0, 59);
  const hours = expand(hour, 0, 23);
  const days = expand(dom, 1, 31);
  const months = expand(month, 1, 12);
  const weekdays = new Set([...expand(dow, 0, 7)].map((day) => day % 7));
  return {
    matches(atMs) {
      const date = new Date(atMs);
      return minutes.has(date.getUTCMinutes()) && hours.has(date.getUTCHours()) && months.has(date.getUTCMonth() + 1)
        && (dom === "*" || days.has(date.getUTCDate())) && (dow === "*" || weekdays.has(date.getUTCDay()));
    },
  };
}

/** The slot id of one fire: the same for every delivery of it (the same function the in-memory scheduler uses; a test holds the two together). */
export function slotIdOf(companyId: string, scheduleId: string, scheduledAt: string): string {
  return createHash("sha256").update(JSON.stringify([companyId, scheduleId, new Date(scheduledAt).toISOString()])).digest("hex");
}

/** Refuses an entry this adapter could not run: the id, the rule, the zone, the interval and the lateness window. */
export function checkEntry(entry: ScheduleEntry): void {
  if (!isScheduleId(entry.scheduleId)) throw new SchedulerError("refused", "not a schedule id");
  if (entry.when.kind === "cron") {
    if (!INTERVAL_SCHEDULER_CAPABILITIES.timezones.includes(entry.when.timezone)) throw new SchedulerError("refused", "this scheduler does not run that time zone");
    parseCron(entry.when.cron);
  } else if (!Number.isInteger(entry.when.minutes) || entry.when.minutes < INTERVAL_SCHEDULER_CAPABILITIES.minEveryMinutes) {
    throw new SchedulerError("refused", "that interval is shorter than this scheduler runs");
  }
  if (entry.maxLateSeconds !== undefined && (!Number.isInteger(entry.maxLateSeconds) || entry.maxLateSeconds < 1)) throw new SchedulerError("refused", "not a latest delivery time");
}

/** `JSON.parse(JSON.stringify(...))`: drops `undefined` fields, which a document may not hold. */
const documentOf = (value: object): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;
const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const floorMinute = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/** The latest slot `s` with `after < s <= now` for a rule that took effect at `anchorMs`, looking back at most `lookBackMs`; undefined when there is none. */
export function latestSlot(when: ScheduleEntry["when"], anchorMs: number, afterMs: number, nowMs: number, lookBackMs: number): number | undefined {
  const end = floorMinute(nowMs);
  const floor = Math.max(afterMs, nowMs - Math.min(lookBackMs, LOOK_BACK_MAX_MINUTES * MINUTE_MS));
  if (when.kind === "every") {
    const step = when.minutes * MINUTE_MS;
    const base = floorMinute(anchorMs);
    if (end < base) return undefined;
    const slot = base + Math.floor((end - base) / step) * step;
    return slot > floor ? slot : undefined;
  }
  const matcher = parseCron(when.cron);
  for (let at = end; at > floor; at -= MINUTE_MS) if (matcher.matches(at)) return at;
  return undefined;
}

// ---- the adapter

export interface TimerHandle { stop(): void }
export type TimerFactory = (everyMs: number, tick: () => void) => TimerHandle;

export interface IntervalSchedulerOptions {
  store: DocumentStore;
  now?: () => number;
  /** Starts the timer when a handler subscribes. `false`: no timer (the caller calls `tick()`). Default: `setInterval` every `tickMs`, unref'd. */
  timer?: false | TimerFactory;
  tickMs?: number;
  /** How long to wait before attempt 2 and attempt 3 of a fire (default 1 s and 5 s). */
  retryWaitsMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** One short fixed-word event a line; never a target's content. */
  log?: (event: { event: string; scheduleId?: string; attempt?: number; reason?: string }) => void;
}

export interface IntervalScheduler extends Scheduler {
  /** Looks at every schedule once and delivers what is due. Resolves when this tick's deliveries are done. Never throws. */
  tick(): Promise<void>;
}

interface StoredSchedule { entry: ScheduleEntry; anchorMs: number; handledMs: number }

const entryKey = (companyId: string, scheduleId: string): DocumentKey => ({ pk: companyScoped(companyId, "SCHEDULER"), sk: `SCHEDULE#${scheduleId}` });
const companyKey = (companyId: string): DocumentKey => ({ pk: COMPANIES_PARTITION, sk: companyId });

function readStored(item: Readonly<Record<string, unknown>> | undefined): StoredSchedule | undefined {
  if (item === undefined) return undefined;
  const { entry, anchorMs, handledMs } = item;
  if (typeof entry !== "object" || entry === null || typeof anchorMs !== "number" || typeof handledMs !== "number") return undefined;
  return { entry: entry as ScheduleEntry, anchorMs, handledMs };
}

export function createIntervalScheduler(options: IntervalSchedulerOptions): IntervalScheduler {
  const { store } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const waits = options.retryWaitsMs ?? DEFAULT_RETRY_WAITS_MS;
  const log = options.log ?? (() => undefined);
  let handler: ((due: DueSchedule) => Promise<void>) | undefined;
  let timer: TimerHandle | undefined;
  let closed = false;
  let ticking: Promise<void> | undefined;

  const startTimer = (): void => {
    if (timer !== undefined || options.timer === false || closed) return;
    const factory: TimerFactory = options.timer ?? ((everyMs, tick) => {
      const interval = setInterval(tick, everyMs);
      interval.unref();
      return { stop: () => { clearInterval(interval); } };
    });
    timer = factory(options.tickMs ?? DEFAULT_TICK_MS, () => { void scheduler.tick(); });
  };

  async function companies(): Promise<string[]> {
    const rows: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.query({ pk: COMPANIES_PARTITION, ...(cursor === undefined ? {} : { cursor }) });
      for (const item of page.items) if (typeof item["sk"] === "string") rows.push(item["sk"]);
      cursor = page.cursor;
    } while (cursor !== undefined);
    return rows;
  }

  async function deliver(entry: ScheduleEntry, slotMs: number): Promise<void> {
    const scheduledAt = new Date(slotMs).toISOString();
    for (let attempt = 1; attempt <= ATTEMPTS_MAX; attempt += 1) {
      const current = handler;
      if (current === undefined || closed) return;
      try {
        await current({ companyId: entry.companyId, scheduleId: entry.scheduleId, scheduledAt, slotId: slotIdOf(entry.companyId, entry.scheduleId, scheduledAt), attempt, target: structuredClone(entry.target) });
        return;
      } catch {
        log({ event: "scheduler.handler_failed", scheduleId: entry.scheduleId, attempt });
        if (attempt < ATTEMPTS_MAX) await sleep(waits[Math.min(attempt - 1, waits.length - 1)] ?? 0);
      }
    }
    log({ event: "scheduler.fire_given_up", scheduleId: entry.scheduleId, reason: "handler_failed" });
  }

  async function tickOnce(): Promise<void> {
    if (closed || handler === undefined) return;
    const at = now();
    let ids: string[];
    try { ids = await companies(); } catch { return; }
    for (const companyId of ids) {
      let page: { items: readonly Readonly<Record<string, unknown>>[]; cursor?: string | undefined };
      let cursor: string | undefined;
      do {
        try { page = await store.query({ pk: companyScoped(companyId, "SCHEDULER"), sk: { op: "beginsWith", prefix: "SCHEDULE#" }, ...(cursor === undefined ? {} : { cursor }) }); } catch { break; }
        cursor = page.cursor;
        for (const item of page.items) {
          const stored = readStored(item);
          if (stored === undefined || !stored.entry.enabled) continue;
          const lookBackMs = (stored.entry.maxLateSeconds ?? DEFAULT_MAX_LATE_SECONDS) * 1000;
          let slot: number | undefined;
          try { slot = latestSlot(stored.entry.when, stored.anchorMs, stored.handledMs, at, lookBackMs); } catch { continue; }
          if (slot === undefined) continue;
          await deliver(stored.entry, slot);
          if (handler === undefined || closed) continue;
          // The slot counts as handled whether the handler took it or gave up; a newer fire is never held back by an older one. Only moves forward, and only on the row as it was read.
          await store.update({ key: entryKey(companyId, stored.entry.scheduleId), ops: [{ op: "set", path: ["handledMs"], value: slot }], condition: when.and(when.present(), when.eq("anchorMs", stored.anchorMs), when.lt("handledMs", slot)) }).catch(() => undefined);
        }
      } while (cursor !== undefined);
    }
  }

  const scheduler: IntervalScheduler = {
    capabilities: INTERVAL_SCHEDULER_CAPABILITIES,

    async put(entry) {
      checkEntry(entry);
      const at = now();
      const key = entryKey(entry.companyId, entry.scheduleId);
      const previous = readStored(await store.get(key));
      // The rule's anchor moves only when the rule or its switch changed: putting the same entry again (every approval does) keeps the schedule where it is. A rule that is new, changed or switched back on never fires for a slot before now.
      const keep = previous !== undefined && sameJson(previous.entry.when, entry.when) && previous.entry.enabled === entry.enabled;
      const anchorMs = keep ? previous.anchorMs : at;
      const handledMs = keep ? previous.handledMs : at;
      await store.put({ item: documentOf({ ...key, entityType: "SCHEDULER_ENTRY", entry, anchorMs, handledMs }) });
      await store.put({ item: { ...companyKey(entry.companyId), entityType: "SCHEDULER_COMPANY" } });
    },

    async remove(companyId, scheduleId) {
      const removed = await store.delete({ key: entryKey(companyId, scheduleId), condition: when.present(), return: "old" });
      return removed.applied;
    },

    async get(companyId, scheduleId) {
      const stored = readStored(await store.get(entryKey(companyId, scheduleId)));
      return stored === undefined ? undefined : structuredClone(stored.entry);
    },

    subscribe(next): ScheduleSubscription {
      handler = next;
      startTimer();
      return { async stop() { if (handler === next) handler = undefined; } };
    },

    tick() {
      // Ticks never overlap: a tick that is still delivering is awaited, not run beside a new one.
      ticking = (ticking ?? Promise.resolve()).then(tickOnce).catch(() => undefined);
      return ticking;
    },

    async close() {
      closed = true;
      handler = undefined;
      timer?.stop();
      timer = undefined;
      await ticking;
    },
  };
  return scheduler;
}
